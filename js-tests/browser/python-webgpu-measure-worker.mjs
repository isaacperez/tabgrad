import { attachPython } from "/python.js";
import { createWebGpuRuntimeSession } from "/index.js";

const lengths = [65536, 262144, 1048576];
const maximumOwnedGpuBytes = 32 * 1024 * 1024;
const maximumInterpreterBytes = 256 * 1024 * 1024;
const maximumBurstMilliseconds = 5000;
const maximumTotalMilliseconds = 60000;
const semanticCounters = ["liveTensorHandles", "liveTensorValues", "liveOperationRecords", "liveMaterializationRecords", "liveRequestLeases"];

function checkResources(diagnostics) {
  if (diagnostics.webgpu.peakOwnedBufferBytes > maximumOwnedGpuBytes) throw new Error("Owned GPU budget exceeded.");
  if (diagnostics.webgpu.ownedBufferBytes !== 0 || diagnostics.webgpu.pendingSubmissions !== 0
    || diagnostics.webgpu.unknownCompletionBytes !== 0) throw new Error("GPU obligations survived a measured case.");
  for (const name of semanticCounters) if (diagnostics[name] !== 0) throw new Error(`Retained ${name}.`);
}

function checkBurst(milliseconds) {
  for (const value of Object.values(milliseconds)) if (value > maximumBurstMilliseconds) throw new Error("Measurement burst budget exceeded.");
}

function checkTotalBudget(report, started) {
  report.totalMilliseconds = performance.now() - started;
  if (report.totalMilliseconds > maximumTotalMilliseconds) throw new Error("Total measurement budget exceeded.");
}

async function awaitRequestRetirement(session) {
  const started = performance.now();
  while (session.diagnostics().liveRequestLeases !== 0) {
    if (performance.now() - started > maximumBurstMilliseconds) throw new Error("Request retirement exceeded its budget.");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function timerResolution() {
  let increment = Infinity;
  let previous = performance.now();
  for (let index = 0; index < 10000; index += 1) {
    const next = performance.now();
    if (next > previous) increment = Math.min(increment, next - previous);
    previous = next;
  }
  return Number.isFinite(increment) ? increment : null;
}

function expected(index, depth) { return ((index % 65) - 32) * 0.125 + depth * ((index % 33) - 16) * 0.25; }

async function measureJavascript(session, length, depth) {
  const start = performance.now();
  const left = session.tensor(Float32Array.from({ length }, (_, index) => ((index % 65) - 32) * 0.125), { device: "webgpu" });
  const right = session.tensor(Float32Array.from({ length }, (_, index) => ((index % 33) - 16) * 0.25), { device: "webgpu" });
  const imported = performance.now();
  let current = left;
  for (let index = 0; index < depth; index += 1) {
    const previous = current;
    current = previous.add(right);
    if (previous !== left) previous.close();
  }
  const admitted = performance.now();
  let values = await current.toArray();
  const firstObserved = performance.now();
  for (const index of [0, Math.floor(length / 2), length - 1]) {
    if (values[index] !== expected(index, depth)) throw new Error("Incorrect direct GPU sample.");
  }
  values = undefined;
  const rereading = performance.now();
  const cached = await current.toArray();
  const cachedObserved = performance.now();
  if (cached[length - 1] !== expected(length - 1, depth)) throw new Error("Incorrect cached direct sample.");
  const resident = session.diagnostics();
  current.close(); left.close(); right.close();
  // Public Promise publication can precede physical retirement. Resource
  // inspection joins that distinct boundary; it is outside the latency clock.
  await awaitRequestRetirement(session);
  const released = session.diagnostics();
  checkResources(released);
  const milliseconds = { import: imported - start, admission: admitted - imported,
    firstDemandAndObservation: firstObserved - admitted, cachedObservation: cachedObserved - rereading };
  checkBurst(milliseconds);
  return { milliseconds, resident, released };
}

const pythonMeasurement = `
import torch, time, json, gc
def measure_python(length: int, depth: int) -> dict:
    start = time.perf_counter()
    left = torch.tensor([((index % 65) - 32) * 0.125 for index in range(length)], dtype=torch.float32, device='webgpu')
    right = torch.tensor([((index % 33) - 16) * 0.25 for index in range(length)], dtype=torch.float32, device='webgpu')
    imported = time.perf_counter()
    current = left
    for step in range(depth):
        current = current + right
    admitted = time.perf_counter()
    values = current.tolist()
    observed = time.perf_counter()
    for index in [0, length // 2, length - 1]:
        assert values[index] == ((index % 65) - 32) * 0.125 + depth * ((index % 33) - 16) * 0.25
    del values
    rereading = time.perf_counter()
    cached = current.tolist()
    cached_observed = time.perf_counter()
    assert cached[-1] == (((length - 1) % 65) - 32) * 0.125 + depth * (((length - 1) % 33) - 16) * 0.25
    resident = torch._runtime_session.diagnostics().to_py()
    del cached, current, left, right
    gc.collect()
    released = torch._runtime_session.diagnostics().to_py()
    return dict(milliseconds=dict(import_=(imported-start)*1000, admission=(admitted-imported)*1000,
        firstDemandAndObservation=(observed-admitted)*1000, cachedObservation=(cached_observed-rereading)*1000),
        resident=resident, released=released)
`;

const pythonPresentationProbe = `
presentation_probe = dict(calls=0, milliseconds=0.)
original_nested_values = torch._nested_values
def diagnostic_nested_values(values, shape):
    start = time.perf_counter()
    try:
        return original_nested_values(values, shape)
    finally:
        presentation_probe['calls'] += 1
        presentation_probe['milliseconds'] += (time.perf_counter() - start) * 1000
torch._nested_values = diagnostic_nested_values
`;

function transportCounters(connection) {
  const original = connection.port.postMessage.bind(connection.port);
  let counts;
  connection.port.postMessage = (message, transferables) => {
    counts.messages[message.kind] = (counts.messages[message.kind] ?? 0) + 1;
    if (message.completion instanceof SharedArrayBuffer) counts.sharedRecordBytes += message.completion.byteLength;
    if (message.kind === "execute") {
      counts.programComputations += message.program.computations.length;
      for (const binding of message.bindings) {
        if (binding.hostData !== undefined) { counts.hostBindingCopies += 1; counts.hostBindingBytes += binding.hostData.byteLength; }
      }
    }
    original(message, transferables);
  };
  return {
    reset() { counts = { messages: {}, sharedRecordBytes: 0, hostBindingCopies: 0, hostBindingBytes: 0, programComputations: 0 }; },
    snapshot() { return { ...counts, messages: { ...counts.messages } }; },
  };
}

async function installGpuDiagnosticProbe() {
  const [{ ExecutionProbe }, { ExecutionRequest }, { ConnectedWebGpuBackend }, { PythonRuntimeBridge }] = await Promise.all([
    import("/execution-probe.mjs"), import("/execution-request.js"),
    import("/webgpu-connected-backend.js"), import("/python-runtime-bridge.js"),
  ]);
  const probe = new ExecutionProbe();
  try {
    probe.method(ExecutionRequest.prototype, "advance", "requestAdvancement");
    probe.method(PythonRuntimeBridge.prototype, "observe", "pythonRuntimeObservation");
    for (const name of ["prepare", "execute", "read", "release"]) {
      probe.method(ConnectedWebGpuBackend.prototype, name, `connected${name}`);
    }
    return probe;
  } catch (error) { probe.restore(); throw error; }
}

addEventListener("message", async ({ data }) => {
  const report = { ok: false, cases: [], worker: true, crossOriginIsolated,
    mode: data.mode, caps: { maximumOwnedGpuBytes, maximumInterpreterBytes, maximumBurstMilliseconds, maximumTotalMilliseconds } };
  let binding;
  let direct;
  let probe;
  const measurementStarted = performance.now();
  try {
    for (const name of ["Suspending", "promising", "Suspender"]) {
      if (!Reflect.deleteProperty(WebAssembly, name) || name in WebAssembly) throw new Error("Cannot disable JSPI.");
    }
    const start = performance.now();
    const { loadPyodide } = await import("/pyodide/pyodide.mjs");
    const interpreter = await loadPyodide({ indexURL: "/pyodide/" });
    report.interpreterStartupMilliseconds = performance.now() - start;
    report.pyodide = interpreter.version;
    report.jspiAvailable = typeof WebAssembly.Suspending === "function";
    const transport = transportCounters(data.webgpu);
    transport.reset();
    binding = await attachPython(interpreter, { webgpu: data.webgpu });
    await binding.runPythonAsync(pythonMeasurement);
    const acquiring = performance.now();
    direct = await createWebGpuRuntimeSession();
    report.directAcquisitionMilliseconds = performance.now() - acquiring;
    report.timerResolutionMilliseconds = timerResolution();
    if (data.mode === "diagnose") {
      probe = await installGpuDiagnosticProbe();
      await binding.runPythonAsync(pythonPresentationProbe);
    }
    const caseLengths = data.mode === "diagnose" ? [262144] : lengths;
    const depths = data.mode === "measure" ? [1, 8, 32] : [8];
    const samples = data.mode === "diagnose" ? 0 : data.mode === "pilot" ? 3 : 5;
    let caseIndex = 0;
    for (const length of caseLengths) for (const depth of depths) {
      const languages = caseIndex++ % 2 ? ["python", "javascript"] : ["javascript", "python"];
      for (const language of languages) {
        const record = { language, length, depth, samples: [] };
        report.cases.push(record);
        for (let index = 0; index <= samples; index += 1) {
          checkTotalBudget(report, measurementStarted);
          transport.reset();
          probe?.reset();
          let sample;
          if (language === "javascript") sample = await measureJavascript(direct, length, depth);
          else {
            if (probe !== undefined) interpreter.runPython("presentation_probe.update(calls=0, milliseconds=0.)");
            const entering = performance.now();
            await binding.runPythonAsync(`measurement_result = measure_python(${length}, ${depth})`);
            const managedEntryMilliseconds = performance.now() - entering;
            sample = JSON.parse(interpreter.runPython("json.dumps(measurement_result)"));
            sample.milliseconds.import = sample.milliseconds.import_;
            delete sample.milliseconds.import_;
            sample.managedEntryMilliseconds = managedEntryMilliseconds;
            sample.transport = transport.snapshot();
            if (probe !== undefined) sample.pythonListConstruction = JSON.parse(interpreter.runPython("json.dumps(presentation_probe)"));
            sample.interpreterLinearMemoryBytes = interpreter._module.HEAPU8.buffer.byteLength;
            if (sample.interpreterLinearMemoryBytes > maximumInterpreterBytes) throw new Error("Interpreter capacity budget exceeded.");
            checkResources(sample.released);
            checkBurst(sample.milliseconds);
            if (sample.transport.messages.execute !== 1 || sample.transport.messages.read !== 2
              || sample.transport.hostBindingCopies !== 2 || sample.transport.hostBindingBytes !== length * 8
              || sample.transport.programComputations !== depth) throw new Error("Unexpected finite transport counts.");
          }
          if (probe !== undefined) sample.inclusiveDiagnostic = probe.snapshot();
          record.samples.push({ warmup: data.mode !== "diagnose" && index === 0, ...sample });
          checkTotalBudget(report, measurementStarted);
        }
      }
    }
    if (probe !== undefined) await binding.runPythonAsync("torch._nested_values = original_nested_values");
    await direct.close();
    await binding.close();
    report.ok = true;
  } catch (error) {
    report.error = { message: String(error), stack: error?.stack };
  } finally {
    probe?.restore();
    await direct?.close().catch(() => undefined);
    await binding?.close().catch(() => undefined);
    try {
      checkTotalBudget(report, measurementStarted);
    } catch (error) {
      report.ok = false;
      report.error ??= { message: String(error), stack: error?.stack };
    }
  }
  postMessage(report);
}, { once: true });
