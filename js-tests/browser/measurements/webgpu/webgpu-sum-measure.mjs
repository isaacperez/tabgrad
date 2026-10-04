import { WebGpuBackend } from "/backends/webgpu/webgpu-backend.js";
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

function budget(backend, elapsed = 0) {
  if (performance.now() - started > 60000 || elapsed > 5000) throw new Error("Measurement time cap exceeded.");
  if ((backend?.diagnostics().peakOwnedBufferBytes ?? 0) > maximumBytes) throw new Error("GPU owned-byte cap exceeded.");
}

function timerResolution() {
  let previous = performance.now(), minimum = Infinity;
  for (let index = 0; index < 20000; index++) {
    const next = performance.now();
    if (next > previous) minimum = Math.min(minimum, next - previous);
    previous = next;
  }
  if (!Number.isFinite(minimum)) throw new Error("Timer resolution could not be established.");
  return minimum;
}

function program(length, reduced) {
  const provenance = { operation: "tensor", source: "RuntimeSession.tensor" };
  const sum = { operation: "sum", source: "Tensor.sum" };
  const values = [{ slot: 0, storageSlot: 0, dtype: "float32", device: "webgpu",
    layout: "contiguous", shape: [length], source: "binding", provenance }];
  if (reduced) values.push({ ...values[0], slot: 1, storageSlot: 1, shape: [], source: "computed", provenance: sum });
  return new ExecutableProgram(values, reduced ? [{ kind: "sum-f32", inputs: [0], output: 1, provenance: sum }] : [], reduced ? 1 : 0);
}

async function completed(work) {
  if (!(work instanceof ExecutionTicket)) return work;
  try { return await work.result; } finally { await work.drained; }
}

function plannedStorage(length) {
  let count = length, partials = 0, stages = 0;
  do {
    count = Math.max(1, Math.ceil(count / 128));
    stages++;
    if (count > 1) partials += count;
  } while (count > 1);
  return { stages, privateBytes: 44 * partials + 16 * stages, inputBytes: length * 4, outputBytes: 4 };
}

async function batch(backend, selected, bindings, expected) {
  const before = performance.now();
  let output;
  for (let index = 0; index < invocationBatch; index++) {
    if (output !== undefined) backend.release(output);
    const allocations = await completed(backend.execute(selected, bindings, [true, true]));
    output = allocations.get(1);
  }
  const executionMilliseconds = performance.now() - before;
  budget(backend, executionMilliseconds);
  const resident = backend.diagnostics();
  const reading = performance.now();
  const result = await completed(backend.read(output, 1));
  const readbackMilliseconds = performance.now() - reading;
  if (result[0] !== expected) throw new Error("Incorrect exact dyadic total.");
  backend.release(output);
  budget(backend, readbackMilliseconds);
  return { executionMilliseconds, readbackMilliseconds, resident, releasedOutput: backend.diagnostics() };
}

async function measureCase(length, repetitions) {
  const planned = plannedStorage(length);
  if (planned.inputBytes + planned.outputBytes + planned.privateBytes + 4 > maximumBytes) throw new Error("Planned owned GPU budget exceeded.");
  const acquiring = performance.now();
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error("A real WebGPU adapter is required.");
  const backend = new WebGpuBackend(await adapter.requestDevice());
  const acquisitionMilliseconds = performance.now() - acquiring;
  try {
    const selected = program(length, true);
    const preparing = performance.now();
    await backend.prepare(selected);
    const preparationMilliseconds = performance.now() - preparing;
    budget(backend, preparationMilliseconds);
    let integerTotal = 0;
    const input = Float32Array.from({ length }, (_, index) => {
      const integer = index % 17 - 8;
      integerTotal += integer;
      return integer / 4096;
    });
    // All subset sums are exactly representable for these sizes (8*N < 2^24).
    const expected = Math.fround(integerTotal / 4096);
    const uploading = performance.now();
    const allocations = await completed(backend.execute(program(length, false), new Map([[0, { hostData: input }]]), [true]));
    const uploadMilliseconds = performance.now() - uploading;
    const bindings = new Map([[0, { resident: allocations.get(0) }]]);
    budget(backend, uploadMilliseconds);
    for (let warmup = 0; warmup < 3; warmup++) await batch(backend, selected, bindings, expected);
    const observations = [];
    for (let repetition = 0; repetition < repetitions; repetition++) observations.push(await batch(backend, selected, bindings, expected));
    backend.release(allocations.get(0));
    const released = backend.diagnostics();
    if (released.ownedBufferBytes !== 0 || released.pendingSubmissions !== 0 || released.unknownCompletionBytes !== 0) throw new Error("Measurement retained physical obligations.");
    return { length, planned, invocationBatch, expected, acquisitionMilliseconds, preparationMilliseconds,
      uploadMilliseconds, observations, released };
  } finally { await backend.close(); budget(backend); }
}

try {
  await send("__phase", { phase: "application-started" });
  await send("__phase", { phase: "assets-loaded" });
  const resolutionMilliseconds = timerResolution();
  await send("__phase", { phase: "runtime-started" });
  if (!["pilot", "measure"].includes(mode)) throw new Error("Explicit pilot or measure required.");
  for (const length of [65536, 262144, 1048576]) samples.push(await measureCase(length, mode === "pilot" ? 3 : 5));
  await send("__phase", { phase: "runtime-finished" });
  budget();
  await send("__result", { ok: true, mode, resolutionMilliseconds, maximumBytes,
    inputDistribution: "deterministic mixed-sign (index % 17 - 8) / 4096; exact subset sums",
    samples, elapsedMilliseconds: performance.now() - started });
} catch (error) {
  await send("__result", { ok: false, mode, samples, error: { message: error.message, code: error.code } });
}
