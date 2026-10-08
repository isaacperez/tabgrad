import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { loadPyodide } from "pyodide";
import { PythonInstallation } from "../../../dist/frontends/python/python-installation.js";

const packageSources = new Map([
  ["torch/__init__.py", "root"], ["torch/autograd.py", "autograd"], ["torch/optim.py", "optim"],
]);
const sources = { bootstrap: "bootstrap", packageSources };

function installationDouble(failures = new Map()) {
  const events = [];
  const proxies = [];
  const interpreter = {
    runPython(source, options) {
      if (source === "{}") {
        const role = proxies.length === 0 ? "namespace" : "sources";
        events.push(`${role}:acquire`);
        if (failures.has(`${role}:acquire`)) throw failures.get(`${role}:acquire`);
        const proxy = {
          role, values: new Map(), destroys: 0,
          set(key, value) {
            events.push(`${role}:set:${key}`);
            if (failures.has(`${role}:set`)) throw failures.get(`${role}:set`);
            this.values.set(key, value);
          },
          destroy() {
            this.destroys += 1;
            events.push(`${role}:destroy`);
            if (failures.has(`${role}:destroy`)) throw failures.get(`${role}:destroy`);
          },
        };
        proxies.push(proxy);
        return proxy;
      }
      assert.equal(options.globals, proxies[0]);
      const phase = source === "bootstrap" ? "bootstrap"
        : source.includes(".install(") ? "install"
        : source.includes(".close(") ? "close"
        : source.includes("clear()") ? "clear" : "temporaries";
      events.push(phase);
      if (failures.has(phase)) throw failures.get(phase);
    },
  };
  return { interpreter, proxies, events };
}

function errorLeaves(error) {
  if (error instanceof AggregateError) return error.errors.flatMap(errorLeaves);
  return error.cause === undefined ? [error] : errorLeaves(error.cause);
}

test("installation transfers a path dictionary and releases its proxy before import", () => {
  const { interpreter, proxies, events } = installationDouble();
  const installation = new PythonInstallation(interpreter, sources, {});
  assert.equal(proxies.length, 2);
  const [namespace, payload] = proxies;
  assert.deepEqual(payload.values, packageSources);
  assert.equal(namespace.values.get("_package_sources"), payload);
  assert.equal(payload.destroys, 1);
  assert.equal(namespace.destroys, 0);
  assert.ok(events.indexOf("sources:destroy") < events.indexOf("install"));
  installation.close();
  installation.close();
  assert.equal(namespace.destroys, 1);
  assert.equal(payload.destroys, 1);
  assert.ok(events.indexOf("clear") < events.indexOf("namespace:destroy"));
});

for (const phase of ["bootstrap", "sources:acquire", "sources:set", "namespace:set", "sources:destroy", "install", "temporaries"]) {
  test(`failed ${phase} releases each acquired dictionary once`, () => {
    const primary = new Error(phase);
    const { interpreter, proxies, events } = installationDouble(new Map([[phase, primary]]));
    assert.throws(() => new PythonInstallation(interpreter, sources, {}), (error) => {
      assert.equal(error.code, "PYTHON_INSTALL_FAILED");
      assert.deepEqual(errorLeaves(error), [primary]);
      return true;
    });
    assert.ok(proxies.every((proxy) => proxy.destroys === 1));
    assert.equal(events.filter((event) => event === "close").length, phase === "temporaries" ? 1 : 0);
    assert.ok(events.indexOf("clear") < events.indexOf("namespace:destroy"));
    if (phase === "temporaries") assert.ok(events.indexOf("close") < events.indexOf("clear"));
  });
}

for (const phase of ["sources:set", "namespace:set", "install", "temporaries"]) {
  test(`failed ${phase} preserves independent cleanup failures`, () => {
    const primary = new Error(phase);
    const cleanup = new Error("source proxy destroy");
    const clear = new Error("namespace clear");
    const destroy = new Error("namespace destroy");
    const failures = new Map([[phase, primary], ["clear", clear], ["namespace:destroy", destroy]]);
    if (phase.endsWith(":set")) failures.set("sources:destroy", cleanup);
    const { interpreter, proxies } = installationDouble(failures);
    assert.throws(() => new PythonInstallation(interpreter, sources, {}), (error) => {
      assert.deepEqual(errorLeaves(error), phase.endsWith(":set")
        ? [primary, cleanup, clear, destroy] : [primary, clear, destroy]);
      return true;
    });
    assert.ok(proxies.every((proxy) => proxy.destroys === 1));
  });
}

test("failed finalization preserves retirement and both namespace cleanup failures", () => {
  const errors = [new Error("temporaries"), new Error("close"), new Error("clear"), new Error("destroy")];
  const { interpreter, proxies, events } = installationDouble(new Map([
    ["temporaries", errors[0]], ["close", errors[1]], ["clear", errors[2]], ["namespace:destroy", errors[3]],
  ]));
  assert.throws(() => new PythonInstallation(interpreter, sources, {}), (error) => {
    assert.equal(error.code, "PYTHON_INSTALL_FAILED");
    assert.deepEqual(errorLeaves(error), errors);
    return true;
  });
  assert.deepEqual(events.slice(-4), ["temporaries", "close", "clear", "namespace:destroy"]);
  assert.ok(proxies.every((proxy) => proxy.destroys === 1));
});

test("retirement preserves close, namespace clear and destroy failures", () => {
  const errors = [new Error("close"), new Error("clear"), new Error("destroy")];
  const fixture = installationDouble(new Map([["close", errors[0]], ["clear", errors[1]], ["namespace:destroy", errors[2]]]));
  const installation = new PythonInstallation(fixture.interpreter, sources, {});
  assert.throws(() => installation.close(), (error) => {
    assert.deepEqual(errorLeaves(error), errors);
    return true;
  });
  installation.close();
  assert.ok(fixture.proxies.every((proxy) => proxy.destroys === 1));
});

test("real bootstrap rejects malformed source dictionaries before filesystem mutation", { timeout: 15_000 }, async () => {
  const interpreter = await loadPyodide();
  const namespace = interpreter.runPython("{}");
  try {
    interpreter.runPython(await readFile(new URL("../../../dist/python/bootstrap.py", import.meta.url), "utf8"), { globals: namespace });
    interpreter.runPython(`
expected = {'torch/__init__.py': '', 'torch/autograd.py': '', 'torch/optim.py': ''}
before = set(os.listdir('/tmp'))
for malformed in ({}, {**expected, 'extra.py': ''}, {**expected, 'torch/optim.py': 3}):
    installation = Installation()
    try:
        installation.install(malformed, None)
    except ValueError as error:
        assert 'source' in str(error).lower()
    else:
        raise AssertionError('malformed source dictionary accepted')
    assert set(os.listdir('/tmp')) == before
    assert installation.files == [] and installation.directories == []
    assert installation.modules == {} and installation.registration is None
`, { globals: namespace });
  } finally {
    interpreter.runPython("globals().clear()", { globals: namespace });
    namespace.destroy();
  }
});
