import { createWebGpuRuntimeSession } from "/index.js";
import { WebGpuBackend } from "/webgpu-backend.js";
import { ExecutableProgram } from "/execution/executable-program.js";
import { ExecutionTicket } from "/execution/execution-ticket.js";

const query = new URLSearchParams(location.search);
const mode = query.get("mode");
const started = performance.now();
const maximumBytes = 64 * 1024 * 1024;
const invocationBatch = 16;
const samples = [];

async function send(endpoint, body) {
  const response = await fetch(`/${endpoint}?token=${encodeURIComponent(query.get("token"))}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Reporting ${endpoint} failed.`);
}

function checkTimeBudget(duration = 0) {
  if (performance.now() - started > 60_000 || duration > 5_000) throw new Error("Measurement time cap exceeded.");
}

function checkBudget(backend, duration = 0) {
  checkTimeBudget(duration);
  if (backend.diagnostics().ownedBufferBytes > maximumBytes
      || backend.diagnostics().peakOwnedBufferBytes > maximumBytes) throw new Error("GPU owned-byte cap exceeded.");
}

function timerResolution() {
  let previous = performance.now(), minimum = Infinity;
  for (let index = 0; index < 20_000; index += 1) {
    const current = performance.now();
    if (current > previous) minimum = Math.min(minimum, current - previous);
    previous = current;
  }
  if (!Number.isFinite(minimum)) throw new Error("Timer resolution could not be established.");
  return minimum;
}

function program(length, depth) {
  const values = [], computations = [];
  for (let slot = 0; slot < depth + 2; slot += 1) {
    const provenance = slot < 2 ? { operation: "tensor", source: "RuntimeSession.tensor" }
      : { operation: "add", source: "Tensor.add" };
    values.push({ slot, storageSlot: slot, dtype: "float32", device: "webgpu", layout: "contiguous",
      shape: [length], source: slot < 2 ? "binding" : "computed", provenance });
    if (slot >= 2) computations.push({ kind: "add-f32", inputs: [slot === 2 ? 0 : slot - 1, 1], output: slot, provenance });
  }
  return new ExecutableProgram(values, computations, depth === 0 ? 0 : depth + 1);
}

async function physicalResult(work) {
  if (!(work instanceof ExecutionTicket)) return work;
  try { return await work.result; }
  finally { await work.drained; }
}

function releaseOutputs(backend, allocations, bindings) {
  for (const [slot, allocation] of allocations) if (!bindings.has(slot)) backend.release(allocation);
}

function inputData(length, seed) {
  const data = new Float32Array(length);
  let state = seed;
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    data[index] = ((state >>> 0) / 0xffffffff - 0.5) * 2;
  }
  return data;
}

function expectedBoundary(left, right, depth) {
  let first = left[0], last = left.at(-1);
  for (let step = 0; step < depth; step += 1) {
    first = Math.fround(first + right[0]); last = Math.fround(last + right.at(-1));
  }
  return [first, last];
}

async function residentSample(backend, selected, bindings, retained, expected) {
  const before = performance.now();
  let allocations;
  for (let invocation = 0; invocation < invocationBatch; invocation += 1) {
    if (allocations !== undefined) releaseOutputs(backend, allocations, bindings);
    allocations = await physicalResult(backend.execute(selected, bindings, retained));
  }
  const executionMilliseconds = performance.now() - before;
  checkBudget(backend, executionMilliseconds);
  const resident = backend.diagnostics();
  const readStart = performance.now();
  const result = await physicalResult(backend.read(allocations.get(selected.result), selected.values[0].shape[0]));
  const readbackMilliseconds = performance.now() - readStart;
  if (result[0] !== expected[0] || result.at(-1) !== expected[1]) throw new Error("Measurement result mismatch.");
  releaseOutputs(backend, allocations, bindings);
  checkBudget(backend, readbackMilliseconds);
  return { executionMilliseconds, readbackMilliseconds, resident, released: backend.diagnostics() };
}

async function measureCase(length, depth, retainIntermediate, repetitions) {
  // All caps are checked before acquisition/allocation as well as afterwards.
  const plannedBuffers = retainIntermediate ? depth + 3 : 5;
  if (plannedBuffers * length * 4 > maximumBytes) throw new Error("Planned GPU bytes exceed cap.");
  if (performance.now() - started > 60_000) throw new Error("Measurement deadline exceeded.");
  const acquisitionStart = performance.now();
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error("A real WebGPU adapter is required.");
  const backend = new WebGpuBackend(await adapter.requestDevice());
  const acquisitionMilliseconds = performance.now() - acquisitionStart;
  try {
    checkBudget(backend, acquisitionMilliseconds);
    const selected = program(length, depth), inputs = program(length, 0);
    const preparationStart = performance.now();
    await backend.prepare(selected);
    const preparationMilliseconds = performance.now() - preparationStart;
    checkBudget(backend, preparationMilliseconds);
    const left = inputData(length, 0x106), right = inputData(length, 0x107);
    const expected = expectedBoundary(left, right, depth);
    const uploadStart = performance.now();
    const uploaded = await physicalResult(backend.execute(inputs,
      new Map([[0, { hostData: left }], [1, { hostData: right }]]), [true, true]));
    const uploadMilliseconds = performance.now() - uploadStart;
    checkBudget(backend, uploadMilliseconds);
    const bindings = new Map([...uploaded].map(([slot, resident]) => [slot, { resident }]));
    const retained = selected.values.map((value) => retainIntermediate || value.slot < 2 || value.slot === selected.result);
    for (let warmup = 0; warmup < 3; warmup += 1) {
      await residentSample(backend, selected, bindings, retained, expected);
    }
    const observations = [];
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      observations.push(await residentSample(backend, selected, bindings, retained, expected));
    }
    for (const allocation of uploaded.values()) backend.release(allocation);
    const released = backend.diagnostics();
    if (released.ownedBufferBytes !== 0 || released.pendingSubmissions !== 0) throw new Error("Measurement leaked buffers or completion checkpoints.");
    return { length, depth, retainIntermediate, invocationBatch, acquisitionMilliseconds, preparationMilliseconds,
      uploadMilliseconds, inputDistribution: "independent deterministic xorshift32 float32 values in [-1, 1]", observations, released };
  } finally { await backend.close(); }
}

async function publicObservation(length, depth) {
  checkTimeBudget();
  const acquisitionStart = performance.now();
  const session = await createWebGpuRuntimeSession();
  const acquisitionMilliseconds = performance.now() - acquisitionStart;
  try {
    checkTimeBudget(acquisitionMilliseconds);
    const right = session.tensor(new Float32Array(length).fill(1), { device: "webgpu" });
    let current = session.tensor(new Float32Array(length).fill(1), { device: "webgpu" });
    for (let index = 0; index < depth; index += 1) {
      const next = current.add(right); current.close(); current = next;
    }
    right.close();
    checkTimeBudget();
    const start = performance.now();
    const result = await current.toArray();
    const milliseconds = performance.now() - start;
    checkTimeBudget(milliseconds);
    if (result[0] !== depth + 1 || result.at(-1) !== depth + 1) throw new Error("Public observation mismatch.");
    current.close(); await session.close();
    checkTimeBudget();
    if (session.diagnostics().webgpu.peakOwnedBufferBytes > maximumBytes || milliseconds > 5_000) throw new Error("Public observation cap exceeded.");
    return { length, depth, acquisitionMilliseconds, milliseconds,
      inputDistribution: "uniform positive ones (separate integration sample)", diagnostics: session.diagnostics() };
  } finally { await session.close(); }
}

try {
  await send("__phase", { phase: "application-started" });
  await send("__phase", { phase: "assets-loaded" });
  const resolutionMilliseconds = timerResolution();
  await send("__phase", { phase: "runtime-started" });
  if (mode !== "pilot" && mode !== "measure") throw new Error("Explicit pilot or measure mode required.");
  const lengths = [262_144, 1_048_576, 2_097_152];
  for (const length of lengths) {
    for (const depth of mode === "pilot" ? [8] : [1, 8, 32]) {
      samples.push(await measureCase(length, depth, false, mode === "pilot" ? 3 : 5));
    }
  }
  if (mode === "measure") {
    for (const depth of [1, 8, 32]) samples.push(await measureCase(262_144, depth, true, 5));
  }
  const publicSamples = mode === "measure" ? [await publicObservation(1_048_576, 32)] : [];
  checkTimeBudget();
  await send("__phase", { phase: "runtime-finished" });
  checkTimeBudget();
  await send("__result", { ok: true, mode, resolutionMilliseconds, maximumBytes,
    crossOriginIsolated, samples, publicSamples, elapsedMilliseconds: performance.now() - started });
} catch (error) {
  await send("__result", { ok: false, mode, samples, error: { message: error.message, code: error.code } });
}
