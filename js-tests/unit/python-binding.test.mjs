import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { loadPyodide } from "pyodide";
import { RuntimeSession } from "../../dist/index.js";
import { getTestExecutionFailureContext } from "../../dist/testing.js";
import { assertSumFixture } from "./sum-oracle.mjs";

let interpreterPromise;

before(() => {
  mock.method(globalThis, "fetch", async (url) => {
    try {
      return new Response(await readFile(url));
    } catch {
      return new Response(null, { status: 404 });
    }
  });
});
after(() => mock.restoreAll());

function getInterpreter() {
  interpreterPromise ??= loadPyodide();
  return interpreterPromise;
}

test("Python total sum matches bounded native numerical fixtures through tolist", { timeout: 20_000 }, async () => {
  const { attachPython } = await import("../../dist/python.js");
  const interpreter = await getInterpreter();
  const oracle = JSON.parse(await readFile(new URL("../fixtures/python-tensor-oracle.json", import.meta.url), "utf8"));
  const binding = await attachPython(interpreter);
  try {
    for (const fixture of oracle.sumCases) {
      for (const expression of ["source.sum()", "torch.sum(source)", "torch.sum(input=source)"]) {
        await binding.runPythonAsync(`import torch\n${fixture.source}\nresult = ${expression}\nobserved_sum = result.tolist()`);
        assertSumFixture(interpreter.globals.get("observed_sum"), fixture);
        const metadata = interpreter.runPython(oracle.metadataExpression);
        try { assert.deepEqual(JSON.parse(JSON.stringify(metadata.toJs())), fixture.metadata, fixture.name); }
        finally { metadata.destroy(); }
      }
    }
  } finally {
    await binding.close();
    for (const name of ["torch", "source", "result", "observed_sum"]) interpreter.globals.delete(name);
  }
});

test("Python total sum returns a lazy scalar tensor through ordinary observation", { timeout: 20_000 }, async () => {
  const { attachPython } = await import("../../dist/python.js");
  const interpreter = await getInterpreter();
  const binding = await attachPython(interpreter);
  try {
    await binding.runPythonAsync(`
import torch
def check_sum():
    session = torch._runtime_session
    for data, expected in [(3, 3.), ([5], 5.), ([[1, -2], [3, 4]], 6.), ([[], []], 0.)]:
        source = torch.tensor(data, dtype=torch.float32)
        before = session.diagnostics().kernelCalls
        method = source.sum()
        positional = torch.sum(source)
        keyword = torch.sum(input=source)
        assert session.diagnostics().kernelCalls == before
        assert method.shape == torch.Size([])
        assert method.dtype is torch.float32 and method.device == source.device
        del source
        assert method.tolist() == expected
        assert method.tolist() == expected
        assert positional.tolist() == expected and keyword.tolist() == expected
        assert session.diagnostics().kernelCalls == before + 3
        del method, positional, keyword
    assert (torch.tensor([1, 2, 3, 4], dtype=torch.float32).view(2, 2).sum()
            + torch.tensor(5, dtype=torch.float32)).sum().tolist() == 15.
    assert session.diagnostics().liveTensorHandles == 0
    assert session.diagnostics().liveTensorValues == 0
    assert session.diagnostics().liveOperationRecords == 0
    assert session.diagnostics().liveAllocationBytes == 0
check_sum()
`);
  } finally {
    await binding.close();
    for (const name of ["torch", "check_sum"]) interpreter.globals.delete(name);
  }
});

test("Python total sum rejects malformed calls and excluded options before dispatch", { timeout: 20_000 }, async () => {
  const { attachPython } = await import("../../dist/python.js");
  const interpreter = await getInterpreter();
  const binding = await attachPython(interpreter);
  try {
    await binding.runPythonAsync(`
import torch
def check_sum_errors():
    source = torch.tensor([1, 2], dtype=torch.float32)
    expressions = ['torch.sum()', 'torch.sum(1)', 'torch.sum([1])',
        'torch.Tensor.sum(None)', 'source.sum(0)', 'source.sum(dim=None)',
        'source.sum(keepdim=False)', 'source.sum(dtype=None)', 'torch.sum(source, out=None)',
        'torch.sum(source, dim=0)', 'torch.sum(source, dtype=torch.float32)',
        'torch.sum(source, input=source)', 'torch.sum(source, unknown=True)']
    before = torch._runtime_session.diagnostics()
    for expression in expressions:
        try:
            eval(expression)
        except TypeError:
            pass
        else:
            raise AssertionError(expression)
    after = torch._runtime_session.diagnostics()
    assert after.kernelCalls == before.kernelCalls == 0
    assert after.liveTensorHandles == before.liveTensorHandles == 1
    assert after.liveOperationRecords == 0
    source._handle.close()
    from pyodide.ffi import JsException
    try:
        source.sum()
    except JsException as error:
        assert error.js_error.code == 'CLOSED_TENSOR'
    else:
        raise AssertionError('closed source accepted')
check_sum_errors()
`);
  } finally {
    await binding.close();
    for (const name of ["torch", "check_sum_errors"]) interpreter.globals.delete(name);
  }
});

async function countCpuCompilations(compile) {
  const modules = await Promise.all(compile.mock.calls.map((call) => call.result));
  return modules.filter((module) => WebAssembly.Module.exports(module)
    .some((entry) => entry.name === "tabgrad_add_f32")).length;
}

function assertObservationContextRejected(interpreter, expression) {
  interpreter.runPython(`
from pyodide.ffi import JsException
try:
    ${expression}
except JsException as error:
    assert error.js_error.code == 'PYTHON_SYNC_CONTEXT_REQUIRED'
else:
    raise AssertionError('unmanaged observation was accepted')
`);
}

test("managed Python prepares CPU once before the first statement without demanding tensors", {
  timeout: 20_000,
}, async (context) => {
  const { attachPython } = await import("../../dist/python.js");
  const interpreter = await getInterpreter();
  const compile = context.mock.method(WebAssembly, "compile");
  const binding = await attachPython(interpreter);
  const session = interpreter.runPython("__import__('torch')._runtime_session");
  const originalRun = interpreter.runPythonAsync.bind(interpreter);
  context.mock.method(interpreter, "runPythonAsync", (source) => {
    const diagnostics = session.diagnostics();
    assert.equal(diagnostics.backendLoads, 1);
    assert.ok(diagnostics.selectedVariant !== null);
    assert.equal(diagnostics.wasmMemoryBytes, 32 * 65_536);
    assert.equal(diagnostics.liveRequestLeases, 0);
    return originalRun(source);
  });
  try {
    assert.equal(session.diagnostics().backendLoads, 0);
    await binding.runPythonAsync("pass");
    await binding.runPythonAsync(`
import torch
prepared_result = torch.tensor([1], dtype=torch.float32) + torch.tensor([2], dtype=torch.float32)
`);
    assert.equal(await countCpuCompilations(compile), 1);
    assert.equal(session.diagnostics().kernelCalls, 0);
    assert.equal(session.diagnostics().hostToWasmCopies, 0);
    assert.equal(session.diagnostics().liveAllocationBytes, 0);
    const handle = interpreter.runPython("prepared_result._handle");
    assert.deepEqual(Array.from(await handle.toArray()), [3]);
    assert.equal(await countCpuCompilations(compile), 1);
    assert.equal(session.diagnostics().kernelCalls, 1);
  } finally {
    await binding.close();
    if (interpreter.globals.has("prepared_result")) interpreter.globals.delete("prepared_result");
  }
  assert.equal(session.diagnostics().wasmMemoryBytes, 0);
});

for (const failPreparation of [false, true]) {
  test(`CPU preparation ${failPreparation ? "failure" : "success"} owns admission and close ordering`, {
    timeout: 20_000,
  }, async (context) => {
    const { attachPython } = await import("../../dist/python.js");
    const interpreter = await getInterpreter();
    const binding = await attachPython(interpreter);
    const session = interpreter.runPython("__import__('torch')._runtime_session");
    const entered = Promise.withResolvers();
    const gate = Promise.withResolvers();
    const preparationFailure = new Error("controlled CPU preparation failure");
    const originalFetch = globalThis.fetch;
    const manifestUrl = new URL("../../dist/manifest.json", import.meta.url).href;
    context.mock.method(globalThis, "fetch", async (url) => {
      if (String(url) === manifestUrl) {
        entered.resolve();
        await gate.promise;
        if (failPreparation) throw preparationFailure;
      }
      return originalFetch(url);
    });
    const runPython = context.mock.method(interpreter, "runPythonAsync");
    const sessionClose = context.mock.method(RuntimeSession.prototype, "close");
    const running = binding.runPythonAsync("pass");
    const outcome = running.then(() => undefined, (error) => error);
    try {
      await Promise.race([
        entered.promise,
        outcome.then(() => { throw new Error("Python entered before CPU preparation"); }),
      ]);
      await assert.rejects(binding.runPythonAsync("pass"), { code: "PYTHON_ENTRY_BUSY" });
      const closing = binding.close();
      assert.equal(binding.close(), closing);
      await assert.rejects(binding.runPythonAsync("pass"), { code: "CLOSED_PYTHON_BINDING" });
      assert.equal(runPython.mock.callCount(), 0);
      assert.equal(sessionClose.mock.callCount(), 0);
      gate.resolve();
      const error = await outcome;
      if (failPreparation) {
        assert.equal(error.code, "BACKEND_LOAD_FAILED");
        assert.equal(error.details.phase, "manifest-fetch");
        assert.equal(error.cause, preparationFailure);
        assert.equal(error.details.operation, undefined);
        assert.equal(runPython.mock.callCount(), 0);
      } else {
        assert.equal(error, undefined);
        assert.equal(runPython.mock.callCount(), 1);
      }
      await closing;
      assert.equal(sessionClose.mock.callCount(), 1);
      assert.equal(session.diagnostics().backendLoads, 1);
      assert.equal(session.diagnostics().wasmMemoryBytes, 0);
      assert.equal(session.diagnostics().liveRequestLeases, 0);
      assert.equal(interpreter.runPython("1 + 1"), 2);
    } finally {
      gate.resolve();
      await outcome;
      await binding.close();
    }
  });
}

test("Python contiguous ranks preserve scalar, nested and empty values through managed observation", {
  timeout: 20_000,
}, async () => {
  const { attachPython } = await import("../../dist/python.js");
  const interpreter = await getInterpreter();
  const binding = await attachPython(interpreter);
  try {
    await binding.runPythonAsync(`
import torch
cases = [(2, (), 4.0), ([[1, 2], [3, 4]], (2, 2), [[2., 4.], [6., 8.]]),
         ((([1, 2],), ([3, 4],)), (2, 1, 2), [[[2., 4.]], [[6., 8.]]]),
         ([[], []], (2, 0), [[], []]), ([[[]]], (1, 1, 0), [[[]]])]
for data, shape, expected in cases:
    left = torch.tensor(data, dtype=torch.float32)
    assert left.shape == shape
    result = left + left
    assert result.shape == shape
    assert result.tolist() == expected
    assert result.tolist() == expected
    if shape:
        assert result.tolist() is not result.tolist()
    else:
        assert type(result.tolist()) is float
source = [[1., 2.], [3., 4.]]
copied = torch.tensor(source, dtype=torch.float32)
source[0][0] = 99
assert copied.tolist() == [[1., 2.], [3., 4.]]
returned = copied.tolist()
returned[0][0] = 99
assert copied.tolist() == [[1., 2.], [3., 4.]]
assert (copied + copied).tolist() == [[2., 4.], [6., 8.]]
`);
  } finally {
    await binding.close();
    for (const name of ["torch", "cases", "data", "shape", "expected", "left", "result", "source", "copied", "returned"]) {
      if (interpreter.globals.has(name)) interpreter.globals.delete(name);
    }
  }
});

test("Python ordinary observation returns independent oracle-backed lists without JSPI", {
  timeout: 20_000,
}, async () => {
  const { attachPython } = await import("../../dist/python.js");
  const interpreter = await getInterpreter();
  assert.equal(WebAssembly.Suspending, undefined, "This Node test must establish native JSPI absence.");
  const oracle = JSON.parse(await readFile(new URL("../fixtures/python-tensor-oracle.json", import.meta.url), "utf8"));
  const binding = await attachPython(interpreter);
  try {
    for (const fixture of oracle.cases) {
      await binding.runPythonAsync(`import torch\n${fixture.source}\nvalues = result.tolist()`);
      const list = interpreter.globals.get("values");
      try {
        const values = Float32Array.from(list.toJs());
        const bits = new Uint32Array(values.buffer);
        assert.deepEqual(Array.from(bits, (value, i) => Number.isNaN(values[i]) ? "nan" : value), fixture.bits);
      } finally {
        list.destroy();
      }
      await binding.runPythonAsync(`
again = result.tolist()
assert all(type(value) is float for value in again)
assert again is not values
if values:
    values[0] = 99
    assert again[0] != 99
assert torch._runtime_session.diagnostics().liveRequestLeases == 0
`);
    }
  } finally {
    await binding.close();
    for (const name of ["torch", "left", "right", "result", "values", "again"]) {
      if (interpreter.globals.has(name)) interpreter.globals.delete(name);
    }
  }
});

test("ordinary Python observation shares completed requests with JavaScript and nested control flow", {
  timeout: 20_000,
}, async () => {
  const { attachPython } = await import("../../dist/python.js");
  const interpreter = await getInterpreter();
  const binding = await attachPython(interpreter);
  const observations = [];
  interpreter.registerJsModule("_observation_test", {
    observe(handle) { observations.push(handle.toArray()); },
    invoke(callback, value) { return callback(value); },
  });
  try {
    await binding.runPythonAsync(`
import torch
from _observation_test import observe, invoke
def nested(value):
    return value.tolist()
left = torch.tensor([1, 2], dtype=torch.float32)
right = torch.tensor([3, 4], dtype=torch.float32)
result = left + right
observe(result._handle)
if nested(result) == [4, 6]:
    assert (result + left).tolist() == [5, 8]
else:
    raise AssertionError('wrong data-dependent branch')
assert invoke(lambda value: value.tolist() == [5, 8], result + left)
assert left.tolist() == [1, 2]
assert torch.tensor([], dtype=torch.float32).tolist() == []
assert torch._runtime_session.diagnostics().kernelCalls == 3
assert torch._runtime_session.diagnostics().liveRequestLeases == 0
assert not hasattr(result, 'tolist_async')
`);
    assert.deepEqual(Array.from(await observations[0]), [4, 6]);
    await assert.rejects(binding.runPythonAsync("raise ValueError('context cleanup')"), /context cleanup/);
    assertObservationContextRejected(interpreter, "result.tolist()");
    await binding.runPythonAsync("assert result.tolist() == [4, 6]");
  } finally {
    await Promise.allSettled(observations);
    await binding.close();
    interpreter.unregisterJsModule("_observation_test");
    interpreter.runPython("import sys; sys.modules.pop('_observation_test', None); None");
    for (const name of ["nested", "observe", "invoke", "left", "right", "result"]) {
      if (interpreter.globals.has(name)) interpreter.globals.delete(name);
    }
  }
});

test("Python synchronous observation rejects an unsupported entry before demand even for host data", {
  timeout: 15_000,
}, async () => {
  const { attachPython } = await import("../../dist/python.js");
  const interpreter = await getInterpreter();
  const binding = await attachPython(interpreter);
  try {
    await binding.runPythonAsync(`
import torch
value = torch.tensor([1], dtype=torch.float32)
deferred_value = value + value
`);
    assertObservationContextRejected(interpreter, "value.tolist()");
    assertObservationContextRejected(interpreter, "deferred_value.tolist()");
    const session = interpreter.runPython("torch._runtime_session");
    assert.equal(session.diagnostics().backendLoads, 1);
    assert.equal(session.diagnostics().liveRequestLeases, 0);
    assert.equal(session.diagnostics().kernelCalls, 0);
  } finally {
    await binding.close();
    for (const name of ["torch", "value", "deferred_value"]) {
      if (interpreter.globals.has(name)) interpreter.globals.delete(name);
    }
  }
});

test("ordinary observation preserves native kernel failure and invocation provenance", {
  timeout: 20_000,
}, async (context) => {
  const { attachPython } = await import("../../dist/python.js");
  const interpreter = await getInterpreter();
  const originalInstantiate = WebAssembly.instantiate.bind(WebAssembly);
  const cause = new WebAssembly.RuntimeError("controlled kernel trap");
  context.mock.method(WebAssembly, "instantiate", async (...args) => {
    const result = await originalInstantiate(...args);
    if (result instanceof WebAssembly.Instance && result.exports.tabgrad_add_f32 !== undefined) {
      return { exports: {
        ...result.exports,
        tabgrad_add_f32() { throw cause; },
      } };
    }
    return result;
  });
  const binding = await attachPython(interpreter);
  try {
    await binding.runPythonAsync(`
import torch
from pyodide.ffi import JsException
trap_result = torch.tensor([1], dtype=torch.float32) + torch.tensor([2], dtype=torch.float32)
try:
    trap_result.tolist()
except JsException as error:
    observation_failure = error.js_error
else:
    raise AssertionError('kernel failure was hidden')
assert torch._runtime_session.diagnostics().liveRequestLeases == 0
assert torch._runtime_session.diagnostics().liveAllocationBytes == 0
`);
    const error = interpreter.globals.get("observation_failure");
    assert.equal(error.code, "BACKEND_TRAP");
    assert.equal(error.cause, cause);
    const failure = getTestExecutionFailureContext(error);
    assert.equal(failure.phase, "execution");
    assert.equal(failure.operation, "add");
    assert.equal(failure.program.computations.length, 1);
  } finally {
    await binding.close();
    for (const name of ["trap_result", "observation_failure"]) {
      if (interpreter.globals.has(name)) interpreter.globals.delete(name);
    }
  }
});

test("script-result cleanup keeps ordinary observation inside its managed entry", {
  timeout: 20_000,
}, async () => {
  const { attachPython } = await import("../../dist/python.js");
  const interpreter = await getInterpreter();
  const binding = await attachPython(interpreter);
  try {
    await binding.runPythonAsync(`
import torch
cleanup_tensor = torch.tensor([5], dtype=torch.float32)
cleanup_values = None
class ObservationOnCleanup:
    def __del__(self):
        global cleanup_values
        try:
            cleanup_values = cleanup_tensor.tolist()
        except Exception:
            cleanup_values = 'observation failed during result cleanup'
ObservationOnCleanup()
`);
    assert.equal(interpreter.runPython("cleanup_values == [5.0]"), true);
    assertObservationContextRejected(interpreter, "cleanup_tensor.tolist()");
  } finally {
    await binding.close();
    for (const name of ["cleanup_tensor", "cleanup_values", "ObservationOnCleanup"]) {
      if (interpreter.globals.has(name)) interpreter.globals.delete(name);
    }
  }
});

test("ordinary observation validates foreign, forged and closed runtime handles", {
  timeout: 20_000,
}, async () => {
  const { attachPython } = await import("../../dist/python.js");
  const interpreter = await getInterpreter();
  const foreignSession = new RuntimeSession();
  const foreign = foreignSession.tensor([7]);
  interpreter.globals.set("observation_foreign", foreign);
  const binding = await attachPython(interpreter);
  try {
    await binding.runPythonAsync(`
import torch
import _tabgrad_runtime_bridge as observation_bridge
from pyodide.ffi import JsException
closed = torch.tensor([1], dtype=torch.float32)
closed._handle.close()
for handle, expected in ((observation_foreign, 'DIFFERENT_SESSION'),
                         (closed._handle, 'CLOSED_TENSOR'),
                         ({}, 'INVALID_TENSOR')):
    try:
        observation_bridge.observe(handle)
    except JsException as error:
        assert error.js_error.code == expected
    else:
        raise AssertionError('invalid observation handle was accepted')
assert observation_bridge.session.diagnostics().liveRequestLeases == 0
assert observation_bridge.session.diagnostics().kernelCalls == 0
`);
  } finally {
    await binding.close();
    await foreignSession.close();
    for (const name of ["observation_foreign", "observation_bridge", "closed", "handle", "expected"]) {
      if (interpreter.globals.has(name)) interpreter.globals.delete(name);
    }
  }
});

test("Python tensor creation, metadata and three lazy addition spellings match the pinned oracle", {
  timeout: 20_000,
}, async () => {
  const { attachPython } = await import("../../dist/python.js");
  const interpreter = await getInterpreter();
  const oracle = JSON.parse(await readFile(new URL("../fixtures/python-tensor-oracle.json", import.meta.url), "utf8"));
  for (const fixture of [...oracle.cases, ...oracle.rankCases]) {
    const binding = await attachPython(interpreter);
    try {
      await binding.runPythonAsync(`import torch\n${fixture.source}`);
      const session = interpreter.runPython("torch._runtime_session");
      assert.equal(session.diagnostics().kernelCalls, 0, fixture.name);
      assert.equal(session.diagnostics().liveOperationRecords, 1, fixture.name);
      const metadata = interpreter.runPython(oracle.metadataExpression);
      try {
        // Python None becomes JS undefined; JSON arrays encode both as null.
        assert.deepEqual(JSON.parse(JSON.stringify(metadata.toJs())), fixture.metadata, fixture.name);
      } finally {
        metadata.destroy();
      }
      // Internal observation isolates this checkpoint from the separate public
      // Python observation contract; the numbers still use real CPU kernels.
      const handle = interpreter.runPython("result._handle");
      const values = await handle.toArray();
      const bits = new Uint32Array(values.buffer, values.byteOffset, values.length);
      assert.deepEqual(Array.from(bits, (value, index) => Number.isNaN(values[index]) ? "nan" : value),
        fixture.bits, fixture.name);
      if ("values" in fixture) {
        await binding.runPythonAsync(`import json\nobserved_json = json.dumps(result.tolist())`);
        assert.deepEqual(JSON.parse(interpreter.globals.get("observed_json")), fixture.values);
        interpreter.globals.delete("observed_json");
      }
      for (const name of ["left", "right", "result"]) interpreter.globals.delete(name);
      assert.equal(session.diagnostics().liveTensorHandles, 0, fixture.name);
      assert.equal(session.diagnostics().liveTensorValues, 0, fixture.name);
    } finally {
      await binding.close();
      for (const name of ["left", "right", "result", "torch"]) {
        if (interpreter.globals.has(name)) interpreter.globals.delete(name);
      }
    }
  }
});

test("Python metadata behavior and semantic error classes match bounded native fixtures", {
  timeout: 15_000,
}, async () => {
  const { attachPython } = await import("../../dist/python.js");
  const interpreter = await getInterpreter();
  const oracle = JSON.parse(await readFile(new URL("../fixtures/python-tensor-oracle.json", import.meta.url), "utf8"));
  const binding = await attachPython(interpreter);
  try {
    await binding.runPythonAsync(`import torch\n${oracle.cases[0].source}`);
    for (const fixture of oracle.errors) {
      interpreter.globals.set("expression", fixture.expression);
      await binding.runPythonAsync(`
try:
    eval(expression)
except Exception as error:
    exception_type = type(error).__name__
    exception_text = str(error)
else:
    exception_type = None
    exception_text = 'no exception'
`);
      assert.equal(interpreter.globals.get("exception_type"), fixture.type,
        `${fixture.expression}: ${interpreter.globals.get("exception_text")}`);
    }
    for (const fixture of oracle.metadataCases) {
      const result = interpreter.runPython(fixture.expression);
      try {
        assert.deepEqual(result.toJs(), fixture.value, fixture.expression);
      } finally {
        result.destroy();
      }
    }
    await binding.runPythonAsync(`
for name, value in [('shape', (4,)), ('dtype', torch.float32), ('device', 'cpu')]:
    try:
        setattr(left, name, value)
    except AttributeError:
        pass
    else:
        raise AssertionError('metadata was writable')
`);
    assert.equal(interpreter.runPython("torch._runtime_session.diagnostics().kernelCalls"), 0);
  } finally {
    await binding.close();
    for (const name of ["torch", "left", "right", "result", "expression", "exception_type", "exception_text", "name", "value"]) {
      if (interpreter.globals.has(name)) interpreter.globals.delete(name);
    }
  }
});

test("Python view syntax, shape inference and observation match the pinned oracle", { timeout: 20_000 }, async () => {
  const { attachPython } = await import("../../dist/python.js");
  const interpreter = await getInterpreter();
  const oracle = JSON.parse(await readFile(new URL("../fixtures/python-tensor-oracle.json", import.meta.url), "utf8"));
  const binding = await attachPython(interpreter);
  try {
    for (const fixture of oracle.viewCases) {
      await binding.runPythonAsync(`import torch\n${fixture.source}\nobserved = result.tolist()`);
      const metadata = interpreter.runPython(oracle.metadataExpression);
      const observed = interpreter.globals.get("observed");
      try {
        // Python None crosses as undefined; normalize the fixture's JSON null.
        assert.deepEqual(JSON.parse(JSON.stringify(metadata.toJs())), fixture.metadata, fixture.name);
        assert.deepEqual(observed?.toJs ? observed.toJs() : observed, fixture.values, fixture.name);
      } finally { metadata.destroy(); observed?.destroy?.(); }
    }
    await binding.runPythonAsync(`
import gc
base = torch.tensor([1, 2, 3, 4, 5, 6], dtype=torch.float32)
matrix = base.view(2, 3)
del base
gc.collect()
result = matrix + matrix
flat = result.view(-1)
del result, matrix
gc.collect()
assert flat.tolist() == [2., 4., 6., 8., 10., 12.]
assert not hasattr(flat, 'tolist_async')
for expression in ['flat.view(torch.float32)', 'flat.view(range(6))', 'flat.view(shape=(6,))']:
    try:
        eval(expression)
    except TypeError:
        pass
    else:
        raise AssertionError(expression)
del flat
gc.collect()
`);
  } finally {
    await binding.close();
    for (const name of ["torch", "base", "result", "observed", "gc", "expression"]) {
      if (interpreter.globals.has(name)) interpreter.globals.delete(name);
    }
  }
});

test("Python nested admission rejects malformed trees without importing partial tensors", {
  timeout: 20_000,
}, async () => {
  const { attachPython } = await import("../../dist/python.js");
  const interpreter = await getInterpreter();
  const binding = await attachPython(interpreter);
  try {
    await binding.runPythonAsync(`
import torch
cycle = []
cycle.append(cycle)
indirect = [cycle]
class NumericSubclass(int):
    pass
bad_inputs = [cycle, indirect, [[1], [2, 3]], [1, [2]], [[1], 2],
              [[], [1]], [[], [[]]], [1, []], [[], 1],
              {'x': 1}, [None], [[complex(1)]], [[NumericSubclass(1)]],
              iter([1]), [[object()]]]
for data in bad_inputs:
    before = torch._runtime_session.diagnostics()
    try:
        torch.tensor(data, dtype=torch.float32)
    except (TypeError, ValueError):
        pass
    else:
        raise AssertionError('accepted malformed input')
    after = torch._runtime_session.diagnostics()
    assert after.liveTensorHandles == before.liveTensorHandles
    assert after.liveTensorValues == before.liveTensorValues
    assert after.liveOperationRecords == before.liveOperationRecords
    assert after.hostToWasmCopies == before.hostToWasmCopies
shared = [1, 2]
tensor = torch.tensor([shared, shared], dtype=torch.float32)
assert tensor.shape == (2, 2)
assert tensor.tolist() == [[1., 2.], [1., 2.]]
for left_data, right_data in [(1, [1]), ([[1, 2]], [1, 2]), ([], [[]])]:
    left = torch.tensor(left_data, dtype=torch.float32)
    right = torch.tensor(right_data, dtype=torch.float32)
    for operation in (lambda: left + right, lambda: left.add(right), lambda: torch.add(left, right)):
        try:
            operation()
        except RuntimeError:
            pass
        else:
            raise AssertionError('accepted different full shapes')
assert torch._runtime_session.diagnostics().kernelCalls == 0
# Traverse deeper than Python's recursion limit, using only one numeric element.
deep = 3
for _ in range(1200):
    deep = [deep]
deep_tensor = torch.tensor(deep, dtype=torch.float32)
assert deep_tensor.shape == (1,) * 1200
observed = (deep_tensor + deep_tensor).tolist()
for _ in range(1200):
    assert type(observed) is list and len(observed) == 1
    observed = observed[0]
assert observed == 6.0
`);
  } finally {
    await binding.close();
    for (const name of ["torch", "cycle", "indirect", "NumericSubclass", "bad_inputs", "data",
      "before", "after", "shared", "tensor", "left_data", "right_data", "left", "right",
      "operation", "deep", "deep_tensor", "observed", "_"]) {
      if (interpreter.globals.has(name)) interpreter.globals.delete(name);
    }
  }
});

test("Python tensor restrictions, reflected dispatch and input copying fail before invalid work", {
  timeout: 15_000,
}, async () => {
  const { attachPython } = await import("../../dist/python.js");
  const interpreter = await getInterpreter();
  const binding = await attachPython(interpreter);
  try {
    await binding.runPythonAsync(`
import torch
source = [1.0, 2.0]
left = torch.tensor(source, dtype=torch.float32)
source[0] = 99
right = torch.tensor((3, 4), dtype=torch.float32, device=torch.device('cpu'))
class EqualToAnything:
    def __eq__(self, other):
        return True
class Reflected:
    def __radd__(self, other):
        return 'reflected'
assert left + Reflected() == 'reflected'
assert left.__add__(1) is NotImplemented
for expression in [
    'torch.tensor([1])',
    'torch.tensor(object(), dtype=torch.float32)',
    'torch.tensor([[object()]], dtype=torch.float32)',
    "torch.tensor([1], dtype='float32')",
    "torch.tensor([1], dtype=torch.float32, device='cuda')",
    'torch.tensor([1], dtype=torch.float32, device=EqualToAnything())',
    'torch.device(EqualToAnything())',
    'torch.tensor([1], dtype=torch.float32, requires_grad=True)',
    'torch.tensor([1], dtype=torch.float32, pin_memory=True)',
    'torch.add(left, 1)',
    'torch.add(left, right, alpha=2)',
    'torch.add(left, right, out=left)',
    '1 + left',
]:
    try:
        eval(expression)
    except (TypeError, RuntimeError):
        pass
    else:
        raise AssertionError('accepted unsupported input: ' + expression)
assert torch._runtime_session.diagnostics().liveTensorHandles == 2
assert torch._runtime_session.diagnostics().liveOperationRecords == 0
assert torch._runtime_session.diagnostics().kernelCalls == 0
`);
    assert.deepEqual(await interpreter.runPython("left._handle").toArray(), new Float32Array([1, 2]));
  } finally {
    await binding.close();
    for (const name of ["torch", "source", "left", "right", "EqualToAnything", "Reflected", "expression"]) {
      if (interpreter.globals.has(name)) interpreter.globals.delete(name);
    }
  }
});

test("Python wrappers release temporaries, cycles, failed construction and retained tracebacks", {
  timeout: 15_000,
}, async () => {
  const { attachPython } = await import("../../dist/python.js");
  const interpreter = await getInterpreter();
  const binding = await attachPython(interpreter);
  try {
    await binding.runPythonAsync(`
import torch
import gc
for iteration in range(20):
    result = torch.tensor([1], dtype=torch.float32) + torch.tensor([2], dtype=torch.float32)
    assert torch._runtime_session.diagnostics().liveTensorHandles == 1
    assert torch._runtime_session.diagnostics().liveTensorValues == 3
    del result
    assert torch._runtime_session.diagnostics().liveTensorValues == 0
cycle = [torch.tensor([1], dtype=torch.float32)]
cycle.append(cycle)
del cycle
gc.collect()
assert torch._runtime_session.diagnostics().liveTensorHandles == 0
def fail_with_tensor():
    retained = torch.tensor([1], dtype=torch.float32)
    raise ValueError('retained by traceback')
try:
    fail_with_tensor()
except ValueError as error:
    traceback_owner = error
assert torch._runtime_session.diagnostics().liveTensorHandles == 1
del traceback_owner
assert torch._runtime_session.diagnostics().liveTensorHandles == 0
original_finalizer = torch.finalize
def reject_finalizer(*args):
    raise MemoryError('finalizer registration failed')
torch.finalize = reject_finalizer
try:
    torch.tensor([1], dtype=torch.float32)
except MemoryError:
    pass
else:
    raise AssertionError('failure not propagated')
finally:
    torch.finalize = original_finalizer
assert torch._runtime_session.diagnostics().liveTensorHandles == 0
`);
  } finally {
    await binding.close();
    for (const name of ["torch", "gc", "iteration", "result", "cycle", "fail_with_tensor", "traceback_owner", "original_finalizer", "reject_finalizer"]) {
      if (interpreter.globals.has(name)) interpreter.globals.delete(name);
    }
  }
});

test("Python wrappers keep runtime handle validation and old-session identity", {
  timeout: 15_000,
}, async () => {
  const { attachPython } = await import("../../dist/python.js");
  const interpreter = await getInterpreter();
  const external = new RuntimeSession();
  const foreignHandle = external.tensor([1]);
  interpreter.globals.set("foreign_handle", foreignHandle);
  const binding = await attachPython(interpreter);
  let replacement;
  try {
    await binding.runPythonAsync(`
import torch
from pyodide.ffi import JsException
left = torch.tensor([1], dtype=torch.float32)
foreign = torch.Tensor._from_handle(foreign_handle)
try:
    left.add(foreign)
except JsException as error:
    assert error.js_error.code == 'DIFFERENT_SESSION'
else:
    raise AssertionError('foreign handle accepted')
fake = object.__new__(torch.Tensor)
fake._handle = {}
try:
    left.add(fake)
except JsException as error:
    assert error.js_error.code == 'INVALID_TENSOR'
else:
    raise AssertionError('forged handle accepted')
left._handle.close()
for expression in ('left.shape', 'left.dtype', 'left.device', 'left.add(left)'):
    try:
        eval(expression)
    except JsException as error:
        assert error.js_error.code == 'CLOSED_TENSOR'
    else:
        raise AssertionError('closed handle accepted')
old_torch = torch
old_factory = torch.tensor
`);
    await binding.close();
    replacement = await attachPython(interpreter);
    await replacement.runPythonAsync(`
import torch
assert torch is not old_torch
try:
    old_factory([1], dtype=old_torch.float32)
except JsException as error:
    assert error.js_error.code == 'CLOSED_SESSION'
else:
    raise AssertionError('old factory rebound')
new_tensor = torch.tensor([1], dtype=torch.float32)
assert torch._runtime_session.diagnostics().liveTensorHandles == 1
del left, foreign, fake, old_factory, old_torch
`);
  } finally {
    await replacement?.close();
    await binding.close();
    await external.close();
    for (const name of ["torch", "left", "foreign", "fake", "foreign_handle", "expression", "old_torch", "old_factory", "new_tensor"]) {
      if (interpreter.globals.has(name)) interpreter.globals.delete(name);
    }
  }
});

test("Python buffer import owns only the bounded float32 input and releases its loan", {
  timeout: 15_000,
}, async () => {
  const { attachPython } = await import("../../dist/python.js");
  const interpreter = await getInterpreter();
  const binding = await attachPython(interpreter);
  let tensor;
  try {
    await binding.runPythonAsync(`
from array import array
import _tabgrad_runtime_bridge as bridge
source = array('f', [99, 1.25, -2.5, 88])
window = memoryview(source)[1:3]
handle = bridge.tensorFromBuffer(window)
window.release()
source[1] = 500
source.append(77)  # A retained buffer export would forbid resizing.
`);
    tensor = interpreter.globals.get("handle");
    assert.ok(tensor instanceof (await import("../../dist/index.js")).Tensor);
    assert.deepEqual(tensor.shape, [2]);
    assert.deepEqual(await tensor.toArray(), new Float32Array([1.25, -2.5]));
    await binding.runPythonAsync(`
empty = array('f')
empty_handle = bridge.tensorFromBuffer(empty)
empty.append(1)
`);
    const emptyTensor = interpreter.globals.get("empty_handle");
    try {
      assert.deepEqual(await emptyTensor.toArray(), new Float32Array());
    } finally {
      emptyTensor.close();
    }
  } finally {
    tensor?.close();
    await binding.close();
    for (const name of ["source", "window", "handle", "empty", "empty_handle", "bridge"]) {
      if (interpreter.globals.has(name)) interpreter.globals.delete(name);
    }
  }
});

test("Python buffer import rejects unsupported views and closed sessions without retaining exports", {
  timeout: 15_000,
}, async () => {
  const { attachPython } = await import("../../dist/python.js");
  const interpreter = await getInterpreter();
  const binding = await attachPython(interpreter);
  try {
    await binding.runPythonAsync(`
from array import array
from pyodide.ffi import JsException
import _tabgrad_runtime_bridge as bridge
for format_code in ('i', 'd'):
    source = array(format_code, [1, 2])
    try:
        bridge.tensorFromBuffer(source)
    except JsException as error:
        assert error.js_error.code == 'INVALID_DATA'
    else:
        raise AssertionError('non-float32 buffer accepted')
    source.append(3)
source = array('f', [1, 2, 3, 4])
for window in (memoryview(source)[::2], memoryview(source)[::-1],
               memoryview(source).cast('B').cast('f', (2, 2))):
    try:
        bridge.tensorFromBuffer(window)
    except JsException as error:
        assert error.js_error.code == 'INVALID_DATA'
    else:
        raise AssertionError('unsupported layout accepted')
    finally:
        window.release()
source.append(5)
assert bridge.session.diagnostics().liveTensorHandles == 0
assert bridge.session.diagnostics().backendLoads == 1
assert bridge.session.diagnostics().kernelCalls == 0
`);
    await binding.close();
    interpreter.runPython(`
try:
    bridge.tensorFromBuffer(source)
except JsException as error:
    assert error.js_error.code == 'CLOSED_SESSION'
else:
    raise AssertionError('closed session accepted an import')
source.append(6)
`);
  } finally {
    await binding.close();
    for (const name of ["source", "window", "bridge", "format_code"]) {
      if (interpreter.globals.has(name)) interpreter.globals.delete(name);
    }
  }
});

test("attachment imports built static Python source without polluting host globals", {
  timeout: 15_000,
}, async () => {
  const { attachPython } = await import("../../dist/python.js");
  const interpreter = await getInterpreter();
  const globalsBefore = interpreter.runPython("tuple(globals())");
  const binding = await attachPython(interpreter);
  try {
    const globalsAfter = interpreter.runPython("tuple(globals())");
    try {
      assert.deepEqual(globalsAfter.toJs(), globalsBefore.toJs());
    } finally {
      globalsAfter.destroy();
    }
    await binding.runPythonAsync(`
import torch
assert torch.__file__.endswith('/torch/__init__.py')
assert torch._runtime_session is not None
`);
  } finally {
    globalsBefore.destroy();
    await binding.close();
  }
  assert.equal(interpreter.runPython("__import__('importlib.util').util.find_spec('torch') is None"), true);
});

test("attachment rejects unavailable, incompatible and corrupt artifacts before interpreter mutation", {
  timeout: 15_000,
}, async (context) => {
  const { attachPython } = await import("../../dist/python.js");
  const interpreter = await getInterpreter();
  const originalFetch = globalThis.fetch;
  for (const failure of ["missing", "version", "hash", "path"]) {
    const replacement = context.mock.method(globalThis, "fetch", async (url) => {
      if (failure === "missing") return new Response(null, { status: 404 });
      const response = await originalFetch(url);
      if (!String(url).endsWith("manifest.json")) return response;
      const manifest = await response.json();
      if (failure === "version") manifest.bridgeVersion += 1;
      if (failure === "hash") manifest.files[0].sha256 = "0".repeat(64);
      if (failure === "path") manifest.files[0].path = "../escape.py";
      return Response.json(manifest);
    });
    try {
      await assert.rejects(attachPython(interpreter).then(async (unexpected) => {
        await unexpected.close();
      }), { code: "PYTHON_ASSET_INVALID" });
    } finally {
      replacement.mock.restore();
    }
    const binding = await attachPython(interpreter);
    await binding.close();
  }
});

test("attachment refuses cached modules and unimported JavaScript registrations", {
  timeout: 15_000,
}, async () => {
  const { attachPython } = await import("../../dist/python.js");
  const interpreter = await getInterpreter();
  for (const name of ["torch", "_tabgrad_runtime_bridge"]) {
    interpreter.registerJsModule(name, { hostOwned: true });
    try {
      await assert.rejects(attachPython(interpreter).then(async (unexpected) => {
        await unexpected.close();
      }), { code: "PYTHON_INSTALL_FAILED" });
      assert.equal(interpreter.runPython(`__import__('${name}').hostOwned`), true);
    } finally {
      interpreter.unregisterJsModule(name);
      interpreter.runPython(`__import__('sys').modules.pop('${name}', None); None`);
    }
    interpreter.runPython(`__import__('sys').modules['${name}'] = None`);
    try {
      await assert.rejects(attachPython(interpreter).then(async (unexpected) => {
        await unexpected.close();
      }), { code: "PYTHON_INSTALL_FAILED" });
      assert.equal(interpreter.runPython(`'${name}' in __import__('sys').modules`), true);
    } finally {
      interpreter.runPython(`__import__('sys').modules.pop('${name}', None); None`);
    }
  }
});

test("close preserves host replacements and retained modules keep the old closed session", {
  timeout: 15_000,
}, async () => {
  const { attachPython } = await import("../../dist/python.js");
  const interpreter = await getInterpreter();
  const binding = await attachPython(interpreter);
  await binding.runPythonAsync(`
import torch, sys, types
old_torch = torch
host_module = types.ModuleType('torch')
sys.modules['torch'] = host_module
`);
  interpreter.registerJsModule("_tabgrad_runtime_bridge", { hostOwned: true });
  await binding.close();
  try {
    assert.equal(interpreter.runPython("sys.modules['torch'] is host_module"), true);
    interpreter.runPython("sys.modules.pop('_tabgrad_runtime_bridge', None); None");
    assert.equal(interpreter.runPython("__import__('_tabgrad_runtime_bridge').hostOwned"), true);
    assert.throws(() => interpreter.runPython("old_torch._runtime_session.tensor([])"), /closed/i);
  } finally {
    interpreter.unregisterJsModule("_tabgrad_runtime_bridge");
    interpreter.runPython("sys.modules.pop('_tabgrad_runtime_bridge', None); sys.modules.pop('torch'); None");
  }
  const replacement = await attachPython(interpreter);
  try {
    assert.throws(() => interpreter.runPython("old_torch._runtime_session.tensor([])"), /closed/i);
  } finally {
    await replacement.close();
  }
});

test("failed Python import rolls back files, paths, modules and the owned session", {
  timeout: 15_000,
}, async (context) => {
  const { attachPython } = await import("../../dist/python.js");
  const interpreter = await getInterpreter();
  interpreter.runPython("import os, sys; before_tmp = set(os.listdir('/tmp')); before_path = tuple(sys.path)");
  const source = "from _tabgrad_runtime_bridge import session\nraise RuntimeError('injected import failure')\n";
  const bytes = Buffer.from(source);
  const originalFetch = globalThis.fetch;
  const replacement = context.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith("torch/__init__.py")) return new Response(bytes);
    const response = await originalFetch(url);
    if (!String(url).endsWith("manifest.json")) return response;
    const manifest = await response.json();
    const file = manifest.files.find((entry) => entry.path === "torch/__init__.py");
    file.byteLength = bytes.length;
    file.sha256 = createHash("sha256").update(bytes).digest("hex");
    return Response.json(manifest);
  });
  const sessionClose = context.mock.method(RuntimeSession.prototype, "close");
  try {
    await assert.rejects(attachPython(interpreter), (error) => {
      assert.equal(error.code, "PYTHON_INSTALL_FAILED");
      assert.match(String(error.cause), /injected import failure/);
      return true;
    });
  } finally {
    replacement.mock.restore();
  }
  assert.equal(sessionClose.mock.callCount(), 1);
  assert.equal(interpreter.runPython("set(os.listdir('/tmp')) == before_tmp and tuple(sys.path) == before_path"), true);
  assert.equal(interpreter.runPython("'torch' not in sys.modules and '_tabgrad_runtime_bridge' not in sys.modules"), true);
  const binding = await attachPython(interpreter);
  await binding.close();
});

test("cleanup preserves replaced files, equal host paths and importer-cache identities", {
  timeout: 15_000,
}, async () => {
  const { attachPython } = await import("../../dist/python.js");
  const interpreter = await getInterpreter();
  const binding = await attachPython(interpreter);
  await binding.runPythonAsync(`
import torch, sys
from pathlib import Path
owned_file = Path(torch.__file__)
owned_root = owned_file.parent.parent
host_path = str(owned_root)
sys.path.insert(0, host_path)
host_finder = object()
sys.path_importer_cache[host_path] = host_finder
owned_file.write_text('# host replacement')
`);
  await binding.close();
  try {
    assert.equal(interpreter.runPython("any(entry is host_path for entry in sys.path)"), true);
    assert.equal(interpreter.runPython("owned_file.read_text() == '# host replacement'"), true);
    assert.equal(interpreter.runPython("sys.path_importer_cache.get(host_path) is host_finder"), true);
  } finally {
    interpreter.runPython(`
sys.path[:] = [entry for entry in sys.path if entry is not host_path]
sys.path_importer_cache.pop(host_path, None)
owned_file.unlink()
owned_file.parent.rmdir()
owned_root.rmdir()
`);
  }
});

test("rollback also owns a file when writing fails after creating it", {
  timeout: 15_000,
}, async () => {
  const { attachPython } = await import("../../dist/python.js");
  const interpreter = await getInterpreter();
  interpreter.runPython(`
import os
from pathlib import Path
before_tmp = set(os.listdir('/tmp'))
original_write = Path.write_bytes
def failing_write(self, data):
    original_write(self, data[:4])
    raise OSError('injected partial write')
Path.write_bytes = failing_write
`);
  try {
    await assert.rejects(attachPython(interpreter), { code: "PYTHON_INSTALL_FAILED" });
  } finally {
    interpreter.runPython("Path.write_bytes = original_write");
  }
  assert.equal(interpreter.runPython("set(os.listdir('/tmp')) == before_tmp"), true);
});

test("installed Python packages conflict before any Tabgrad filesystem mutation", {
  timeout: 15_000,
}, async () => {
  const { attachPython } = await import("../../dist/python.js");
  const interpreter = await getInterpreter();
  interpreter.runPython(`
import tempfile, sys, os
from pathlib import Path
host_root = Path(tempfile.mkdtemp(prefix='host-package-'))
(host_root / 'torch.py').write_text('host_owned = True')
sys.path.insert(0, str(host_root))
before_tmp = set(os.listdir('/tmp'))
`);
  try {
    await assert.rejects(attachPython(interpreter), { code: "PYTHON_INSTALL_FAILED" });
    assert.equal(interpreter.runPython("set(os.listdir('/tmp')) == before_tmp"), true);
    assert.equal(interpreter.runPython("'torch' not in sys.modules"), true);
  } finally {
    interpreter.runPython(`
sys.path.remove(str(host_root))
sys.path_importer_cache.pop(str(host_root), None)
(host_root / 'torch.py').unlink()
host_root.rmdir()
`);
  }
});

test("Python rollback preserves both the primary failure and its cleanup failure", {
  timeout: 15_000,
}, async () => {
  const { attachPython } = await import("../../dist/python.js");
  const interpreter = await getInterpreter();
  for (const primaryType of ["ValueError", "KeyboardInterrupt"]) {
    interpreter.runPython(`
import os, sys
from pathlib import Path
before_tmp = set(os.listdir('/tmp'))
before_path = tuple(sys.path)
original_write = Path.write_bytes
original_unlink = Path.unlink
def failing_write(self: Path, data: bytes) -> int:
    original_write(self, data)
    raise ${primaryType}('primary write failure')
def failing_unlink(self: Path, missing_ok: bool = False) -> None:
    original_unlink(self, missing_ok=missing_ok)
    raise OSError('rollback unlink failure')
Path.write_bytes = failing_write
Path.unlink = failing_unlink
`);
    try {
      await assert.rejects(attachPython(interpreter), (error) => {
        assert.equal(error.code, "PYTHON_INSTALL_FAILED");
        const detail = String(error.cause);
        assert.match(detail, /Python installation and rollback failed/);
        assert.match(detail, new RegExp(`${primaryType}: primary write failure`));
        assert.match(detail, /Python installation cleanup failed/);
        assert.match(detail, /OSError: rollback unlink failure/);
        return true;
      });
    } finally {
      interpreter.runPython("Path.write_bytes = original_write; Path.unlink = original_unlink");
    }
    assert.equal(interpreter.runPython("set(os.listdir('/tmp')) == before_tmp and tuple(sys.path) == before_path"), true);
    assert.equal(interpreter.runPython("'torch' not in sys.modules and '_tabgrad_runtime_bridge' not in sys.modules"), true);
    const binding = await attachPython(interpreter);
    await binding.close();
  }
});

test("Python cleanup aggregates filesystem failures and continues releasing owned entries", {
  timeout: 15_000,
}, async (context) => {
  const { attachPython } = await import("../../dist/python.js");
  const interpreter = await getInterpreter();
  const run = interpreter.runPython;
  let namespace;
  context.mock.method(interpreter, "runPython", (source, options) => {
    const result = run(source, options);
    if (source === "{}") namespace = result;
    return result;
  });
  interpreter.runPython("import os, sys; before_tmp = set(os.listdir('/tmp')); before_path = tuple(sys.path)");
  const binding = await attachPython(interpreter);
  try {
    interpreter.runPython(`
original_unlink = Path.unlink
original_rmdir = Path.rmdir
def failing_unlink(self: Path, missing_ok: bool = False) -> None:
    original_unlink(self, missing_ok=missing_ok)
    raise OSError('unlink completed with failure')
def failing_rmdir(self: Path) -> None:
    original_rmdir(self)
    raise OSError('rmdir completed with failure')
Path.unlink = failing_unlink
Path.rmdir = failing_rmdir
try:
    try:
        _installation.close()
    except ExceptionGroup as error:
        assert error.message == 'Python installation cleanup failed'
        assert [str(item) for item in error.exceptions] == [
            'unlink completed with failure',
            'rmdir completed with failure',
            'rmdir completed with failure',
        ]
    else:
        raise AssertionError('cleanup failures were lost')
finally:
    Path.unlink = original_unlink
    Path.rmdir = original_rmdir
assert _installation.files == [] and _installation.directories == []
assert _installation.modules == {} and _installation.registration is None
assert _installation.import_path is None
_installation.close()
`, { globals: namespace });
  } finally {
    await binding.close();
  }
  assert.equal(interpreter.runPython("set(os.listdir('/tmp')) == before_tmp and tuple(sys.path) == before_path"), true);
  assert.equal(interpreter.runPython("'torch' not in sys.modules and '_tabgrad_runtime_bridge' not in sys.modules"), true);
});

test("repeated attachments release bootstrap proxies and filesystem/import bookkeeping", {
  timeout: 15_000,
}, async (context) => {
  const { attachPython } = await import("../../dist/python.js");
  const interpreter = await getInterpreter();
  const originalRun = interpreter.runPython;
  const destructions = [];
  context.mock.method(interpreter, "runPython", (source, options) => {
    const result = originalRun(source, options);
    if (source === "{}") destructions.push(context.mock.method(result, "destroy"));
    return result;
  });
  interpreter.runPython("import os, sys; before_tmp = set(os.listdir('/tmp')); before_path = tuple(sys.path); before_cache = set(sys.path_importer_cache)");
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const binding = await attachPython(interpreter);
    await binding.close();
  }
  assert.equal(destructions.length, 20);
  assert.ok(destructions.every((destroy) => destroy.mock.callCount() === 1));
  assert.equal(interpreter.runPython("set(os.listdir('/tmp')) == before_tmp and tuple(sys.path) == before_path"), true);
  assert.equal(interpreter.runPython("set(sys.path_importer_cache) == before_cache"), true);
});

test("close releases the installation object without waiting for cyclic garbage collection", {
  timeout: 15_000,
}, async (context) => {
  const { attachPython } = await import("../../dist/python.js");
  const interpreter = await getInterpreter();
  const run = interpreter.runPython;
  let namespace;
  context.mock.method(interpreter, "runPython", (source, options) => {
    const result = run(source, options);
    if (source === "{}") namespace = result;
    return result;
  });
  const binding = await attachPython(interpreter);
  const reference = interpreter.runPython("__import__('weakref').ref(_installation)", { globals: namespace });
  interpreter.globals.set("installation_reference", reference);
  reference.destroy();
  try {
    await binding.close();
    assert.equal(interpreter.runPython("installation_reference() is None"), true);
  } finally {
    interpreter.runPython("del installation_reference");
    await binding.close();
  }
});

test("close reports session and installation failures without losing either error", {
  timeout: 15_000,
}, async (context) => {
  const { attachPython } = await import("../../dist/python.js");
  const interpreter = await getInterpreter();
  const binding = await attachPython(interpreter);
  const sessionFailure = new Error("injected session close failure");
  const close = RuntimeSession.prototype.close;
  context.mock.method(RuntimeSession.prototype, "close", async function () {
    await close.call(this);
    throw sessionFailure;
  });
  const run = interpreter.runPython;
  context.mock.method(interpreter, "runPython", (source, options) => {
    const result = run(source, options);
    if (source === "_installation.close()") throw new Error("injected installation close failure");
    return result;
  });
  await assert.rejects(binding.close(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0], sessionFailure);
    assert.match(String(error.errors[1]), /injected installation close failure/);
    return true;
  });
});

for (const shadow of ["0", "lambda: shadowed_host_namespace"]) {
  test(`attachment owns its namespace when host dict is ${shadow}`, {
    timeout: 15_000,
  }, async () => {
    const { attachPython } = await import("../../dist/python.js");
    const interpreter = await getInterpreter();
    interpreter.runPython(`
shadowed_host_namespace = {'sentinel': 42}
dict = ${shadow}
shadowed_dict = dict
`);
    let binding;
    try {
      binding = await attachPython(interpreter);
      assert.equal(interpreter.runPython(
        "dict is shadowed_dict and shadowed_host_namespace == {'sentinel': 42}",
      ), true);
      await binding.close();
      assert.equal(interpreter.runPython(
        "dict is shadowed_dict and shadowed_host_namespace == {'sentinel': 42}",
      ), true);
    } finally {
      await binding?.close();
      interpreter.runPython("del dict, shadowed_dict, shadowed_host_namespace");
    }
  });
}

test("managed Python scripts preserve host globals and close leaves the interpreter usable", {
  timeout: 15_000,
}, async (context) => {
  const { attachPython } = await import("../../dist/python.js");
  const interpreter = await getInterpreter();
  const sessionClose = context.mock.method(RuntimeSession.prototype, "close");
  interpreter.runPython("host_value = 40");
  const binding = await attachPython(interpreter);
  try {
    assert.equal(await binding.runPythonAsync("answer = host_value + 2; answer"), undefined);
    await binding.runPythonAsync("assert answer == 42");
  } finally {
    await binding.close();
  }
  assert.equal(interpreter.runPython("answer + 1"), 43);
  await binding.close();
  assert.equal(sessionClose.mock.callCount(), 1);
  await assert.rejects(binding.runPythonAsync("host_value = -1"), {
    code: "CLOSED_PYTHON_BINDING",
  });
  assert.equal(interpreter.runPython("host_value"), 40);
});

test("a managed script releases the owned proxy of an unexported Python result", {
  timeout: 15_000,
}, async () => {
  const { attachPython } = await import("../../dist/python.js");
  const interpreter = await getInterpreter();
  const binding = await attachPython(interpreter);
  try {
    await binding.runPythonAsync(`
import weakref
class ScriptResult:
    pass
script_result = ScriptResult()
script_result_ref = weakref.ref(script_result)
script_result
`);
    assert.equal(interpreter.runPython("del script_result; script_result_ref() is None"), true);
  } finally {
    await binding.close();
  }
});

test("close waits for the accepted Python script before closing its session", {
  timeout: 15_000,
}, async (context) => {
  const { attachPython } = await import("../../dist/python.js");
  const interpreter = await getInterpreter();
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  interpreter.registerJsModule("_binding_test_gate", {
    entered: () => entered.resolve(),
    gate: gate.promise,
  });
  const sessionClose = context.mock.method(RuntimeSession.prototype, "close");
  const binding = await attachPython(interpreter);
  const running = binding.runPythonAsync(`
from _binding_test_gate import entered, gate
entered()
await gate
finished_before_close = True
`);
  try {
    await entered.promise;
    const closing = binding.close();
    assert.equal(binding.close(), closing);
    assert.equal(sessionClose.mock.callCount(), 0);
    await assert.rejects(binding.runPythonAsync("raise AssertionError('late entry')"), {
      code: "CLOSED_PYTHON_BINDING",
    });
  } finally {
    gate.resolve();
    await running;
    await binding.close();
    interpreter.unregisterJsModule("_binding_test_gate");
    interpreter.runPython("import sys; sys.modules.pop('_binding_test_gate', None); None");
  }
  assert.equal(sessionClose.mock.callCount(), 1);
  assert.equal(interpreter.runPython("finished_before_close"), true);
});

test("managed entry rejects overlap and recovers after a Python exception", {
  timeout: 15_000,
}, async () => {
  const { attachPython } = await import("../../dist/python.js");
  const interpreter = await getInterpreter();
  interpreter.runPython("overlap_entered = False");
  const binding = await attachPython(interpreter);
  const first = binding.runPythonAsync("pass");
  try {
    await assert.rejects(binding.runPythonAsync("overlap_entered = True"), {
      code: "PYTHON_ENTRY_BUSY",
    });
    await first;
    assert.equal(interpreter.runPython("overlap_entered"), false);
    await assert.rejects(binding.runPythonAsync("raise ValueError('script failure')"), /ValueError: script failure/);
    await binding.runPythonAsync("assert not overlap_entered");
  } finally {
    await first;
    await binding.close();
  }
});

test("attachment is exclusive until close and old bindings never become active again", {
  timeout: 15_000,
}, async () => {
  const { attachPython } = await import("../../dist/python.js");
  const interpreter = await getInterpreter();
  const pending = attachPython(interpreter);
  try {
    await assert.rejects(attachPython(interpreter).then(async (unexpected) => {
      await unexpected.close();
    }), { code: "PYTHON_ALREADY_ATTACHED" });
    const binding = await pending;
    await assert.rejects(attachPython(interpreter).then(async (unexpected) => {
      await unexpected.close();
    }), { code: "PYTHON_ALREADY_ATTACHED" });
    await binding.close();
    const replacement = await attachPython(interpreter);
    try {
      await replacement.runPythonAsync("reattachment_value = 7");
      await assert.rejects(binding.runPythonAsync("reattachment_value = -1"), {
        code: "CLOSED_PYTHON_BINDING",
      });
      assert.equal(interpreter.runPython("reattachment_value"), 7);
    } finally {
      await replacement.close();
    }
  } finally {
    await (await pending).close();
  }
});

test("attachment rejects unsupported Pyodide before creating a runtime session", async (context) => {
  const { attachPython } = await import("../../dist/python.js");
  const sessionClose = context.mock.method(RuntimeSession.prototype, "close");
  for (const invalid of [null, undefined, 42, { version: "0.0.0" }, { version: "314.0.6" }]) {
    await assert.rejects(attachPython(invalid).then(async (unexpected) => {
      await unexpected.close();
    }), { code: "UNSUPPORTED_PYODIDE" });
  }
  assert.equal(sessionClose.mock.callCount(), 0);
});

test("close drains a failing accepted script without taking its error from the caller", {
  timeout: 15_000,
}, async (context) => {
  const { attachPython } = await import("../../dist/python.js");
  const interpreter = await getInterpreter();
  const sessionClose = context.mock.method(RuntimeSession.prototype, "close");
  const binding = await attachPython(interpreter);
  const running = binding.runPythonAsync("raise ValueError('accepted failure')");
  const rejected = assert.rejects(running, /ValueError: accepted failure/);
  const closing = binding.close();
  await rejected;
  await closing;
  assert.equal(sessionClose.mock.callCount(), 1);
  const replacement = await attachPython(interpreter);
  await replacement.close();
});

test("managed results do not destroy a host-owned JavaScript object", {
  timeout: 15_000,
}, async () => {
  const { attachPython } = await import("../../dist/python.js");
  const interpreter = await getInterpreter();
  let destructions = 0;
  const value = { destroy() { destructions += 1; } };
  interpreter.registerJsModule("_binding_test_result", { value });
  const binding = await attachPython(interpreter);
  try {
    await binding.runPythonAsync("from _binding_test_result import value; value");
    assert.equal(destructions, 0);
  } finally {
    await binding.close();
    interpreter.unregisterJsModule("_binding_test_result");
    interpreter.runPython("import sys; sys.modules.pop('_binding_test_result', None); None");
  }
});
