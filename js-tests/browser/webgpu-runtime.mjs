import { createWebGpuRuntimeSession } from "/index.js";
import { exactAddition, equivalentBits, numericalPairs } from "./float32-addition-oracle.mjs";

const token = new URLSearchParams(location.search).get("token");
async function send(endpoint, body) {
  const response = await fetch(`/${endpoint}?token=${encodeURIComponent(token)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Reporting ${endpoint} failed.`);
}

function check(condition, message) { if (!condition) throw new Error(message); }

async function exercise(session) {
  const pairs = numericalPairs();
  for (const depth of [1, 8]) {
    let expected = pairs.left;
    let current = session.tensor(new Float32Array(pairs.left.buffer), { device: "webgpu" });
    const right = session.tensor(new Float32Array(pairs.right.buffer), { device: "webgpu" });
    for (let step = 0; step < depth; step += 1) {
      const next = current.add(right); current.close(); current = next;
      expected = expected.map((bits, index) => exactAddition(bits, pairs.right[index]));
    }
    const actual = new Uint32Array((await current.toArray()).buffer);
    check(actual.length === expected.length, `Truncated numerical readback at depth ${depth}`);
    for (let index = 0; index < actual.length; index += 1) {
      check(equivalentBits(actual[index], expected[index]), `Numerical mismatch at depth ${depth}, pair ${index}: ${actual[index].toString(16)} != ${expected[index].toString(16)}`);
    }
    current.close(); right.close();
  }
  for (const shape of [[], [1], [2, 3], [2, 1, 3], [0], [2, 0, 3]]) {
    const length = shape.reduce((count, dimension) => count * dimension, 1);
    const input = session.tensor(new Float32Array(length).fill(2), { shape, device: "webgpu" });
    const doubled = input.add(input);
    const flat = doubled.view([-1]);
    input.close(); doubled.close();
    const result = await flat.toArray();
    check(result.length === length && result.every((value) => value === 4), "GPU geometry/value mismatch");
    const again = await flat.toArray();
    check(again !== result && again.every((value) => value === 4), "Observation must return independent data");
    flat.close();
  }
  const increment = session.tensor([1, 2, 3], { device: "webgpu" });
  let root = session.tensor([0, 0, 0], { device: "webgpu" });
  for (let index = 0; index < 32; index += 1) {
    const next = root.add(increment); root.close(); root = next;
  }
  increment.close();
  check(JSON.stringify([...await root.toArray()]) === "[32,64,96]", "GPU chain mismatch");
  root.close();
  const base = session.tensor([1, 2, 3, 4], { device: "webgpu" });
  const shared = base.add(base);
  const alias = shared.view([2, 2]);
  const left = shared.add(base);
  const right = shared.add(shared);
  const branch = left.add(right);
  base.close(); shared.close(); left.close(); right.close();
  const before = session.diagnostics().webgpu;
  check(JSON.stringify([...await branch.toArray()]) === "[7,14,21,28]", "GPU branching mismatch");
  const after = session.diagnostics().webgpu;
  check(after.kernelCalls - before.kernelCalls === 4, "Shared producer executed more than once");
  check(after.uploadBytes - before.uploadBytes === 16, "Shared input uploaded more than once");
  branch.close();
  check(JSON.stringify([...await alias.toArray()]) === "[2,4,6,8]", "Retained alias lost its shared storage");
  check(session.diagnostics().webgpu.kernelCalls === after.kernelCalls, "Resident alias recomputed");
  alias.close();
  const cpu = session.tensor([5]);
  check(cpu.device === "cpu" && (await cpu.toArray())[0] === 5, "CPU default changed");
  const cpuResult = cpu.mul(cpu);
  check((await cpuResult.toArray())[0] === 25, "CPU computation changed in GPU-enabled session");
  cpu.close(); cpuResult.close();
}

let session;
try {
  await send("__phase", { phase: "application-started" });
  await send("__phase", { phase: "assets-loaded" });
  session = await createWebGpuRuntimeSession();
  await send("__phase", { phase: "runtime-started" });
  await exercise(session);
  await session.close();
  const diagnostics = session.diagnostics();
  check(diagnostics.webgpu.ownedBufferBytes === 0 && diagnostics.webgpu.pendingSubmissions === 0
    && diagnostics.webgpu.unknownCompletionBytes === 0, "GPU resources did not drain");
  check(diagnostics.liveTensorHandles === 0 && diagnostics.liveTensorValues === 0
    && diagnostics.liveMaterializationRecords === 0 && diagnostics.liveRequestLeases === 0, "Semantic resources did not retire");
  await send("__phase", { phase: "runtime-finished" });
  await send("__result", { ok: true, diagnostics });
} catch (error) {
  await session?.close();
  await send("__result", { ok: false, error: { message: error.message, code: error.code, details: error.details } });
}
