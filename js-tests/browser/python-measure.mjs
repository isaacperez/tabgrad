// Measurement-only worker. No instrumentation is shipped in the public entry.
import { createRuntimeSession } from "/index.js";
import { selectCpuProfile } from "/cpu-profile.mjs";

const lengths = [0, 1, 4, 256, 4096];
const depths = [1, 4, 16];
const repetitions = 6; // One warm-up followed by five retained timing samples.
const maximumCpuBytes = 64 * 1024 * 1024;
const liveCounters = ["liveTensorHandles", "liveTensorValues", "liveOperationRecords",
  "liveMaterializationRecords", "liveRequestLeases", "liveAllocationBytes"];

function assertReleased(diagnostics) {
  for (const name of liveCounters) {
    if (diagnostics[name] !== 0) throw new Error(`Unexpected retained ${name}: ${diagnostics[name]}`);
  }
  if (diagnostics.wasmMemoryBytes > maximumCpuBytes) throw new Error("CPU memory limit exceeded");
}

function assertValues(values, length, depth) {
  if (values.length !== length || values.some((value) => value !== 1.25 + depth * 2.5)) {
    throw new Error(`Incorrect measured result (${length}, ${depth})`);
  }
}

async function measureJavascript(session, length, depth) {
  const start = performance.now();
  const left = session.tensor(new Float32Array(length).fill(1.25));
  const right = session.tensor(new Float32Array(length).fill(2.5));
  const imported = performance.now();
  let result = left;
  for (let index = 0; index < depth; index += 1) {
    const previous = result;
    result = previous.add(right);
    if (previous !== left) previous.close();
  }
  const admitted = performance.now();
  const formed = session.diagnostics();
  const demanded = performance.now();
  const values = await result.toArray();
  const observed = performance.now();
  const cachedValues = await result.toArray();
  const cached = performance.now();
  assertValues(values, length, depth);
  assertValues(cachedValues, length, depth);
  const resident = session.diagnostics();
  const closing = performance.now();
  result.close(); left.close(); right.close();
  const closed = performance.now();
  const released = session.diagnostics();
  assertReleased(released);
  return { milliseconds: { import: imported - start, admission: admitted - imported,
    demandAndObservation: observed - demanded, cachedObservation: cached - observed,
    handleCleanup: closed - closing }, formed, resident, released };
}

const pythonMeasurement = `
import gc, sys, time, tracemalloc
conversion_calls = {}
def profile_conversion(frame, event, argument):
    if event != 'c_call':
        return
    name = getattr(argument, '__name__', '')
    if name not in ('to_py', 'tolist'):
        return
    while frame is not None:
        if frame.f_code is __import__('torch').Tensor.tolist.__code__:
            conversion_calls[name] = conversion_calls.get(name, 0) + 1
            return
        frame = frame.f_back

def measure_python(length, depth, trace=False):
    import torch
    if trace:
        tracemalloc.start()
        tracemalloc.reset_peak()
    start = time.perf_counter()
    left = torch.tensor([1.25] * length, dtype=torch.float32)
    right = torch.tensor([2.5] * length, dtype=torch.float32)
    imported = time.perf_counter()
    result = left
    for _ in range(depth):
        result = result + right
    admitted = time.perf_counter()
    formed = torch._runtime_session.diagnostics().to_py()
    demanded = time.perf_counter()
    values = result.tolist()
    observed = time.perf_counter()
    cached_values = result.tolist()
    cached = time.perf_counter()
    assert len(values) == length
    assert all(value == 1.25 + depth * 2.5 for value in values)
    assert cached_values == values
    resident = torch._runtime_session.diagnostics().to_py()
    closing = time.perf_counter()
    del result, left, right, values, cached_values
    closed = time.perf_counter()
    released = torch._runtime_session.diagnostics().to_py()
    traced = None
    if trace:
        before_gc, peak = tracemalloc.get_traced_memory()
        gc.collect()
        after_gc, _ = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        traced = dict(liveBeforeCollectionBytes=before_gc, peakBytes=peak,
                      liveAfterCollectionBytes=after_gc)
    return dict(milliseconds=dict(import_=(imported-start)*1000,
        admission=(admitted-imported)*1000, demandAndObservation=(observed-demanded)*1000,
        cachedObservation=(cached-observed)*1000, handleCleanup=(closed-closing)*1000),
        formed=formed, resident=resident, released=released, tracedPythonAllocations=traced)

def measure_profiled_python(length, depth):
    global conversion_calls
    conversion_calls = {}
    previous = sys.getprofile()
    sys.setprofile(profile_conversion)
    try:
        result = measure_python(length, depth)
    finally:
        sys.setprofile(previous)
    result['pythonConversionCalls'] = conversion_calls
    return result
`;

function readPythonResult(interpreter) {
  return JSON.parse(interpreter.runPython("__import__('json').dumps(measurement_result)"));
}

async function measurePython(binding, interpreter, length, depth, trace = false, diagnostic = false) {
  const start = performance.now();
  const call = diagnostic ? `measure_profiled_python(${length}, ${depth})`
    : `measure_python(${length}, ${depth}, ${trace ? "True" : "False"})`;
  await binding.runPythonAsync(`measurement_result = ${call}`);
  const managedEntryMilliseconds = performance.now() - start;
  const result = readPythonResult(interpreter);
  result.milliseconds.import = result.milliseconds.import_;
  delete result.milliseconds.import_;
  assertReleased(result.released);
  return { ...result, managedEntryMilliseconds,
    // Pinned Pyodide development diagnostic: capacity, NOT live Python heap.
    interpreterLinearMemoryBytes: interpreter._module.HEAPU8.buffer.byteLength };
}

function assertWorkCounts(before, after, length, depth) {
  const expected = { kernelCalls: depth, hostToWasmCopies: 2, hostToWasmBytes: 8 * length,
    wasmToHostCopies: 2, wasmToHostBytes: 8 * length };
  for (const [name, count] of Object.entries(expected)) {
    if (after[name] - before[name] !== count) {
      throw new Error(`Unexpected ${name}: ${after[name] - before[name]} rather than ${count}`);
    }
  }
}

function assertProbeCounts(probe, sample, language, depth) {
  const boundaries = probe.snapshot();
  const expected = { tensorAdd: depth, tensorClose: depth + 2,
    backendExecution: 1, backendReadback: 2, kernel: depth,
    pythonBufferImport: language === "python" ? 2 : 0,
    pythonObservation: language === "python" ? 2 : 0 };
  for (const [name, count] of Object.entries(expected)) {
    if ((boundaries[name]?.calls ?? 0) !== count || (boundaries[name]?.failures ?? 0) !== 0) {
      throw new Error(`Unexpected diagnostic calls for ${name}: ${JSON.stringify(boundaries[name])}`);
    }
  }
  if (language === "python") {
    for (const name of ["to_py", "tolist"]) {
      if (sample.pythonConversionCalls[name] !== 2) {
        throw new Error(`Unexpected Python conversion calls: ${JSON.stringify(sample.pythonConversionCalls)}`);
      }
    }
  }
  return boundaries;
}

async function measureCase(record, interpreter, attachPython, variant, probe) {
  const { language, length, depth, samples } = record;
  const attaching = performance.now();
  const binding = language === "python" ? await attachPython(interpreter) : undefined;
  const session = binding === undefined ? createRuntimeSession()
    : interpreter.runPython("__import__('torch')._runtime_session");
  const attachmentMilliseconds = performance.now() - attaching;
  const preparing = performance.now();
  try {
    if (binding !== undefined) await binding.runPythonAsync("pass");
    else {
      // Public JS has lazy preparation; use an empty result in both base/current builds.
      const left = session.tensor(new Float32Array(0));
      const right = session.tensor(new Float32Array(0));
      const result = left.add(right);
      await result.toArray(); result.close(); left.close(); right.close();
    }
    const preparationMilliseconds = performance.now() - preparing;
    const prepared = session.diagnostics();
    if (prepared.selectedVariant !== variant) throw new Error("Wrong measured CPU variant");
    for (let repetition = 0; repetition < (probe === undefined ? repetitions : 1); repetition += 1) {
      const before = session.diagnostics();
      probe?.reset();
      const sample = binding === undefined ? await measureJavascript(session, length, depth)
        : await measurePython(binding, interpreter, length, depth, false, probe !== undefined);
      assertWorkCounts(before, sample.released, length, depth);
      if (probe !== undefined) sample.boundaries = assertProbeCounts(probe, sample, language, depth);
      samples.push({ warmup: probe === undefined && repetition === 0, ...sample });
    }
    // Separate diagnostic run: tracing overhead is excluded from timing summaries.
    const memory = binding === undefined || probe !== undefined ? null
      : await measurePython(binding, interpreter, length, depth, true);
    const beforeClose = session.diagnostics();
    const closing = performance.now();
    if (binding === undefined) await session.close(); else await binding.close();
    const closeMilliseconds = performance.now() - closing;
    const afterClose = session.diagnostics();
    assertReleased(afterClose);
    if (afterClose.wasmMemoryBytes !== 0) throw new Error("Closed session retained CPU memory");
    Object.assign(record, { attachmentMilliseconds, preparationMilliseconds,
      prepared, memory, beforeClose, closeMilliseconds, afterClose });
  } finally {
    if (binding === undefined) await session.close(); else await binding.close();
  }
}

async function run({ data }) {
  const report = { ok: false, cases: [], crossOriginIsolated,
    worker: typeof document === "undefined", variant: data.variant,
    diagnostic: data.diagnostic === true };
  let probe;
  try {
    // Explicitly exercise the no-JSPI profile before initializing Pyodide.
    for (const name of ["Suspending", "promising", "Suspender"]) {
      if (!Reflect.deleteProperty(WebAssembly, name) || name in WebAssembly) throw new Error("Cannot disable JSPI");
    }
    let interpreter;
    let attachPython;
    if (data.python) {
      const start = performance.now();
      const module = await import("/pyodide/pyodide.mjs");
      interpreter = await module.loadPyodide({ indexURL: "/pyodide/" });
      report.interpreterStartupMilliseconds = performance.now() - start;
      report.pyodide = interpreter.version;
      const importing = performance.now();
      ({ attachPython } = await import("/python.js"));
      report.pythonEntryImportMilliseconds = performance.now() - importing;
      interpreter.runPython(pythonMeasurement);
    }
    if (data.diagnostic) {
      const { installExecutionProbe } = await import("/execution-probe.mjs");
      probe = await installExecutionProbe();
    }
    selectCpuProfile(data.variant);
    for (const length of lengths) {
      for (const depth of depths) {
        // Alternate first language to reduce a systematic order effect.
        const languages = !data.python ? ["javascript"] : length % 2 ? ["python", "javascript"] : ["javascript", "python"];
        for (const language of languages) {
          const record = { language, length, depth, samples: [] };
          report.cases.push(record);
          await measureCase(record, interpreter, attachPython, data.variant, probe);
        }
      }
    }
    report.ok = true;
  } catch (error) {
    report.error = { message: String(error), stack: error?.stack };
  } finally {
    probe?.restore();
  }
  postMessage(report);
}
addEventListener("message", run, { once: true });
