import assert from "node:assert/strict";
import test from "node:test";
import { runManagedGpuMeasurement } from "../../browser/measurements/python-webgpu/python-webgpu-measure-controller.mjs";

const length = 262144;

function diagnostics() {
  return { liveTensorHandles: 0, liveTensorValues: 0, liveOperationRecords: 0,
    liveMaterializationRecords: 0, liveRequestLeases: 0,
    webgpu: { peakOwnedBufferBytes: 0, ownedBufferBytes: 0, pendingSubmissions: 0, unknownCompletionBytes: 0 } };
}

class MeasurementTensor {
  constructor(values) { this.values = values; }
  add(right) {
    return new MeasurementTensor(this.values.map((value, index) => value + right.values[index]));
  }
  async toArray() { return this.values.slice(); }
  close() {}
}

async function runController({ lastSampleMilliseconds = 0, closeMilliseconds = 0, sampleError } = {}) {
  let elapsed = 0;
  let closed = 0;
  const connection = { port: { postMessage() {} } };
  const interpreter = {
    version: "controlled-test",
    _module: { HEAPU8: new Uint8Array(1) },
    runPython(code) {
      if (!code.includes("json.dumps(measurement_result)")) return "{}";
      elapsed = lastSampleMilliseconds;
      return JSON.stringify({ milliseconds: { import_: 0, admission: 0,
        firstDemandAndObservation: 0, cachedObservation: 0 }, resident: diagnostics(), released: diagnostics() });
    },
  };
  const binding = {
    async runPythonAsync(code) {
      if (!code.startsWith("measurement_result =")) return;
      if (sampleError) throw new Error(sampleError);
      connection.port.postMessage({ kind: "execute", program: { computations: Array(8) },
        bindings: [{ hostData: new Float32Array(length) }, { hostData: new Float32Array(length) }] });
      for (const kind of ["read", "read", "release", "release", "release"]) connection.port.postMessage({ kind });
    },
    async close() { closed += 1; elapsed += closeMilliseconds; },
  };
  const session = {
    tensor(values) { return new MeasurementTensor(values); },
    diagnostics,
    async close() { closed += 1; elapsed += closeMilliseconds; },
  };
  // One diagnostic sample per language exercises the last-sample boundary.
  // An empty diagnostic probe preserves the controller's normal control flow.
  const probe = { method() {}, reset() {}, snapshot() { return []; }, restore() {} };
  const report = await runManagedGpuMeasurement({ mode: "diagnose", webgpu: connection }, {
    clock: { now: () => elapsed }, crossOriginIsolated: true, webAssembly: {},
    attachPython: async () => binding, createWebGpuRuntimeSession: async () => session,
    loadModule: async (specifier) => {
      if (specifier === "/pyodide/pyodide.mjs") return { loadPyodide: async () => interpreter };
      if (specifier === "/helpers/execution-probe.mjs") return { ExecutionProbe: class { constructor() { return probe; } } };
      if (specifier === "/runtime/execution-request.js") return { ExecutionRequest: class {} };
      if (specifier === "/backends/webgpu/webgpu-connected-backend.js") return { ConnectedWebGpuBackend: class {} };
      if (specifier === "/frontends/python/python-runtime-bridge.js") return { PythonRuntimeBridge: class {} };
      throw new Error(`Unexpected worker dependency: ${specifier}`);
    },
  });
  return { report, closed };
}

test("measurement worker rejects a final sample beyond the total budget", async () => {
  const { report } = await runController({ lastSampleMilliseconds: 61000 });
  assert.equal(report.ok, false);
  assert.match(report.error.message, /Total measurement budget exceeded/);
  assert.equal(report.totalMilliseconds, 61000);
});

test("measurement worker rejects slow cleanup and reports its full interval", async () => {
  const { report, closed } = await runController({ closeMilliseconds: 16000 });
  assert.equal(report.ok, false);
  assert.match(report.error.message, /Total measurement budget exceeded/);
  assert.equal(report.totalMilliseconds, 64000);
  assert.equal(closed, 4);
});

test("measurement worker accepts completion exactly at its total limit", async () => {
  const { report } = await runController({ lastSampleMilliseconds: 60000 });
  assert.equal(report.ok, true);
  assert.equal(report.totalMilliseconds, 60000);
  assert.equal(report.cases.length, 2);
});

test("measurement worker preserves the primary error when cleanup also exceeds the limit", async () => {
  const { report } = await runController({ sampleError: "original sample failure", closeMilliseconds: 31000 });
  assert.equal(report.ok, false);
  assert.match(report.error.message, /original sample failure/);
  assert.equal(report.totalMilliseconds, 62000);
});
