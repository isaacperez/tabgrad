import { createWebGpuRuntimeSession } from "/index.js";
import { exactAddition, equivalentBits, numericalPairs } from "../helpers/float32-addition-oracle.mjs";

import { exactTotal, exactCases } from "../helpers/float32-sum-oracle.mjs";

const token = new URLSearchParams(location.search).get("token");
async function send(endpoint, body) {
  const response = await fetch(`/${endpoint}?token=${encodeURIComponent(token)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Reporting ${endpoint} failed.`);
}

function check(condition, message) { if (!condition) throw new Error(message); }

async function exerciseTotalSum(session) {
  for (const [index, bits] of exactCases().entries()) {
    const input = session.tensor(new Float32Array(bits.buffer), { device: "webgpu" });
    const total = input.sum();
    check(total.shape.length === 0 && total.device === "webgpu" && total !== input, "Sum scalar metadata mismatch");
    const actual = new Uint32Array((await total.toArray()).buffer)[0];
    const expected = exactTotal(bits).bits;
    check(equivalentBits(actual, expected), `Exact total mismatch at case ${index}: ${actual.toString(16)} != ${expected.toString(16)}`);
    input.close(); total.close();
  }
  for (const shape of [[], [1], [2, 3], [2, 1, 3], [0], [2, 0, 3]]) {
    const length = shape.reduce((n, dimension) => n * dimension, 1);
    const input = session.tensor(new Float32Array(length).fill(2), { shape, device: "webgpu" });
    const view = input.view([-1]);
    const total = view.sum();
    input.close(); view.close();
    check(total.shape.length === 0 && (await total.toArray())[0] === 2 * length, "View/shape total mismatch");
    total.close();
  }
  // All work stays deferred until the final scalar; intermediate rounding must
  // be observable without reading a subtotal back to the host.
  const input = session.tensor([1, 2 ** -24], { device: "webgpu" });
  const increment = session.tensor([2 ** -24], { shape: [], device: "webgpu" });
  const first = input.sum();
  const added = first.add(increment);
  const result = added.sum();
  input.close(); increment.close(); first.close(); added.close();
  const before = session.diagnostics().webgpu;
  check((await result.toArray())[0] === 1, "Hidden exact subtotal crossed a logical boundary");
  const after = session.diagnostics().webgpu;
  check(after.readbackBytes - before.readbackBytes === 4, "Resident sum chain read an intermediate to host");
  check(after.kernelCalls - before.kernelCalls === 3, "Resident sum/add/sum chain missing a stage");
  const again = await result.toArray();
  check(again[0] === 1 && session.diagnostics().webgpu.kernelCalls === after.kernelCalls, "Resident total was recomputed");
  result.close();

  const left = session.tensor([1, 2 ** -24], { device: "webgpu" });
  const right = session.tensor([2 ** -24, 2 ** -149], { device: "webgpu" });
  const producer = left.add(right);
  const total = producer.sum();
  left.close(); right.close(); producer.close();
  check((await total.toArray())[0] === 1, "Producer rounding was bypassed by total sum");
  total.close();

  // A retired scalar producer provides a nonzero spare allocation for the
  // independent empty reduction in the same region; it must explicitly write +0.
  const scalar = session.tensor([23], { shape: [], device: "webgpu" });
  const nonzero = scalar.add(scalar);
  const nonzeroTotal = nonzero.sum();
  const empty = session.tensor([], { device: "webgpu" });
  const identity = empty.sum();
  const combined = nonzeroTotal.add(identity);
  scalar.close(); nonzero.close(); nonzeroTotal.close(); empty.close(); identity.close();
  check((await combined.toArray())[0] === 46, "Empty reduction did not overwrite reused scalar storage");
  combined.close();
}

async function exercise(session) {
  await exerciseTotalSum(session);
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
  // Execute every lane around full and partial workgroup boundaries. Distinct
  // values make an omitted tail or an incorrectly indexed lane visible.
  for (const length of [63, 64, 65, 127, 128, 129]) {
    const leftData = Float32Array.from({ length }, (_, index) => index + 1);
    const rightData = Float32Array.from({ length }, (_, index) => -(index % 7));
    const left = session.tensor(leftData, { device: "webgpu" });
    const right = session.tensor(rightData, { device: "webgpu" });
    const output = left.add(right);
    left.close(); right.close();
    const actual = await output.toArray();
    check(actual.length === length, `Launch-boundary readback truncated at ${length}`);
    for (let index = 0; index < length; index += 1) {
      check(actual[index] === leftData[index] + rightData[index],
        `Launch-boundary mismatch at length ${length}, element ${index}`);
    }
    output.close();
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
