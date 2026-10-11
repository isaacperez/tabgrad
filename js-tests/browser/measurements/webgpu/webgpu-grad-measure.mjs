import { createWebGpuRuntimeSession } from "/index.js";

const parameters = new URLSearchParams(location.search), token = parameters.get("token");
const mode = parameters.get("mode");
const specifications = [
  { elements: 65, depth: 1, branches: 1, requests: 1, repetitions: 16 },
  { elements: 65536, depth: 1, branches: 1, requests: 1, repetitions: 16 },
  { elements: 1048576, depth: 1, branches: 1, requests: 1, repetitions: 16 },
  { elements: 65536, depth: 8, branches: 1, requests: 1, repetitions: 16 },
  { elements: 65536, depth: 1, branches: 8, requests: 1, repetitions: 16 },
  { elements: 65536, depth: 1, branches: 1, requests: 4, repetitions: 16 },
  { elements: 65536, depth: 1, branches: 1, requests: 1, repetitions: 2 },
  { elements: 65536, depth: 1, branches: 1, requests: 1, repetitions: 32 },
];
function check(condition, message) { if (!condition) throw new Error(message); }
async function report(endpoint, body) {
  const response = await fetch(`/${endpoint}?token=${encodeURIComponent(token)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  check(response.ok, `Reporting ${endpoint} failed`);
}
function timerCalibration() {
  const start = performance.now(); let previous = start, resolution = Infinity;
  for (let index = 0; index < 10000; index++) {
    const current = performance.now();
    if (current > previous) resolution = Math.min(resolution, current - previous);
    previous = current;
  }
  return { resolutionMilliseconds: resolution, probeMilliseconds: performance.now() - start, reads: 10002 };
}

async function sample(session, spec) {
  const x = session.tensor(new Float32Array(spec.elements).fill(2), { device: "webgpu", requiresGrad: true });
  const factor = session.tensor(new Float32Array(spec.elements).fill(1), { device: "webgpu" });
  const baseline = session.diagnostics(), before = baseline.webgpu;
  let admissionMilliseconds = 0, observationMilliseconds = 0;
  try {
    for (let repetition = 0; repetition < spec.repetitions; repetition++) {
      let loss;
      for (let branch = 0; branch < spec.branches; branch++) {
        let current = x;
        for (let depth = 0; depth < spec.depth; depth++) {
          const next = current.mul(factor); if (current !== x) current.close(); current = next;
        }
        const total = current.sum(); current.close();
        if (loss === undefined) loss = total;
        else { const next = loss.add(total); loss.close(); total.close(); loss = next; }
      }
      const requested = Array(spec.requests).fill(x);
      const start = performance.now(), gradients = session.grad(loss, requested);
      admissionMilliseconds += performance.now() - start;
      loss.close();
      const observedAt = performance.now(), values = await gradients[0].toArray();
      observationMilliseconds += performance.now() - observedAt;
      check(values.length === spec.elements && values.every((value) => value === spec.branches), "Derivative value differs");
      check(new Set(gradients).size === spec.requests && gradients.every((value) => value.device === "webgpu" && !value.requiresGrad), "Requested exposures differ");
      for (const value of gradients) value.close();
      // Logical collection is synchronous; ordinary physical release may be
      // queued. Yield before checking that fixed-owner repetition has drained.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const current = session.diagnostics();
      check(current.liveTensorHandles === baseline.liveTensorHandles && current.liveSavedValues === 0
        && current.liveOperationRecords === 0 && current.liveRequestLeases === 0, "Repetition retained temporary owners");
      check(current.webgpu.pendingSubmissions === 0 && current.webgpu.unknownCompletionBytes === 0
        && current.webgpu.ownedBufferBytes <= spec.elements * 4, "Repetition retained temporary GPU buffers");
      check(current.webgpu.peakOwnedBufferBytes <= 32 * 1024 * 1024, "Authorized owned GPU bound exceeded");
    }
    const after = session.diagnostics();
    return { ...spec, admissionMilliseconds, observationMilliseconds,
      uploads: after.webgpu.uploadBytes - before.uploadBytes,
      readbacks: after.webgpu.readbackBytes - before.readbackBytes,
      dispatches: after.webgpu.kernelCalls - before.kernelCalls,
      retainedBufferBytes: after.webgpu.ownedBufferBytes,
      peakOwnedBufferBytes: after.webgpu.peakOwnedBufferBytes,
      liveDerivativeNodes: after.liveDerivativeNodes, liveSavedValues: after.liveSavedValues,
      liveTensorHandles: after.liveTensorHandles, liveRequestLeases: after.liveRequestLeases };
  } finally { x.close(); factor.close(); }
}

let session;
try {
  await report("__phase", { phase: "application-started" });
  await report("__phase", { phase: "assets-loaded" });
  session = await createWebGpuRuntimeSession();
  await report("__phase", { phase: "runtime-started" });
  const calibration = timerCalibration(), cold = await sample(session, { ...specifications[0], repetitions: 1 });
  const records = [];
  for (let round = 0; round < (mode === "pilot" ? 3 : 5); round++) {
    // Alternate order; each row starts with fresh fixed owners, sharing only
    // the session's already prepared pipelines.
    for (const spec of round % 2 ? specifications.toReversed() : specifications) {
      records.push({ round, ...await sample(session, spec) });
    }
  }
  await session.close();
  await report("__phase", { phase: "runtime-finished" });
  await report("__result", { ok: true, calibration, cold, records, diagnostics: session.diagnostics() });
} catch (error) {
  await session?.close().catch(() => undefined);
  await report("__result", { ok: false, error: { message: String(error), stack: error?.stack } });
}
