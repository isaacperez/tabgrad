import { exactAddition, equivalentBits } from "./float32-addition-oracle.mjs";
import { exactMultiplication } from "./float32-multiplication-oracle.mjs";
import { exactCoefficientAddition } from "./float32-coefficient-oracle.mjs";
const MiB = 1024 * 1024;
const maximumCountedGpuBytes = 128 * MiB;
const check = (condition, message) => { if (!condition) throw new Error(message); };

/** Restrict only dispatch geometry on a real device; do not request optional limits. */
export function restrictDispatchAxis(device, axis) {
  const limits = new Proxy(device.limits, { get(target, name) {
    return name === "maxComputeWorkgroupsPerDimension" ? Math.min(axis, target[name]) : Reflect.get(target, name, target);
  } });
  return new Proxy(device, { get(target, name) {
    if (name === "limits") return limits;
    const value = Reflect.get(target, name, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

function checkpoint(session) {
  const gpu = session.diagnostics().webgpu;
  check(!gpu.adapter.isFallbackAdapter, "Hardware qualification requires a nonfallback GPU.");
  check(gpu.peakOwnedBufferBytes <= maximumCountedGpuBytes, "GPU test exceeded its counted buffer budget.");
  check(gpu.unknownCompletionBytes === 0 && gpu.pendingSubmissions === 0, "GPU work did not drain.");
  return gpu;
}

/** Full output checks beyond the former global frontier and the sum's 1D frontier. */
export async function checkLargeGpuDispatch(session) {
  const axis = session.diagnostics().webgpu.limits.maxComputeWorkgroupsPerDimension;
  check(axis === 65535, "This bounded large profile is qualified for an axis of 65,535.");
  const count = axis * 64 + 65;
  const input = session.tensor(Float32Array.from({ length: count }, (_, index) => index % 7 + 1), { device: "webgpu" });
  for (const operation of ["add", "mul"]) {
    const output = input[operation](input);
    try {
      const values = await output.toArray();
      check(values.length === count, "Large GPU result was truncated.");
      for (let index = 0; index < count; index++) {
        const value = index % 7 + 1;
        check(values[index] === (operation === "add" ? 2 * value : value * value), `Large ${operation} mismatch at ${index}.`);
      }
    } finally { output.close(); }
    checkpoint(session);
  }
  input.close();
  const sumCount = axis * 128 + 1;
  const ones = session.tensor(new Float32Array(sumCount).fill(1), { device: "webgpu" }), total = ones.sum();
  try { check((await total.toArray())[0] === sumCount, "Large cooperative sum lost or repeated a partition."); }
  finally { total.close(); ones.close(); }
  const rows = 8, contraction = 2048, columns = 2048;
  const activations = session.tensor(new Float32Array(rows * contraction).fill(1), { shape: [rows, contraction], device: "webgpu" });
  const weights = session.tensor(new Float32Array(contraction * columns).fill(1 / contraction), { shape: [contraction, columns], device: "webgpu" });
  const matrix = activations.matmul(weights);
  try { check((await matrix.toArray()).every(value => value === 1), "Million-weight matrix changed its small output."); }
  finally { matrix.close(); weights.close(); activations.close(); }
  return { elements: count, sumElements: sumCount, matrixWeights: contraction * columns, matrixOutputElements: rows * columns, gpu: checkpoint(session) };
}

/** Public differentiation/update paths force both invocation and cooperative grids. */
export async function checkGpuDispatchComposition(session) {
  const axis = session.diagnostics().webgpu.limits.maxComputeWorkgroupsPerDimension;
  const count = axis * 128 + 129, owned = [];
  const own = tensor => { owned.push(tensor); return tensor; };
  let optimizer;
  try {
    const x = own(session.tensor(new Float32Array(count).fill(1), { device: "webgpu", requiresGrad: true }));
    const total = own(x.sum()), seed = own(session.tensor([-0], { shape: [], device: "webgpu" }));
    const negative = own(session.grad(total, [x], seed)[0]);
    check(new Uint32Array((await negative.toArray()).buffer).every(word => word === 0x80000000), "Grid expansion lost negative zero.");
    const square = own(x.mul(x)), loss = own(square.sum());
    loss.backward();
    const gradient = own(x.grad), alias = own(gradient.view([count]));
    check((await gradient.toArray()).every(value => value === 2), "Grid backward gradient changed.");
    const captured = own(x.add(x));
    optimizer = session.sgd([x], { lr: .25 });
    optimizer.step();
    check((await x.toArray()).every(value => value === .5), "Grid coefficient update changed.");
    check((await captured.toArray()).every(value => value === 2), "Update lost a captured prior value.");
    optimizer.zeroGrad(false);
    check(x.grad === gradient, "Numeric reset replaced gradient identity.");
    check((await alias.toArray()).every(value => Object.is(value, 0)), "Grid reset did not update gradient aliases.");
    for (const columns of [4, 5]) {
      const rows = axis * 64 + 1;
      const left = own(session.tensor(new Float32Array(rows).fill(2), { shape: [rows, 1], device: "webgpu" }));
      const right = own(session.tensor(Float32Array.from({ length: columns }, (_, i) => i + 1), { shape: [1, columns], device: "webgpu", requiresGrad: true }));
      const output = own(left.mul(right));
      const values = await output.toArray();
      check(values.every((value, i) => value === 2 * (i % columns + 1)), "Grid broadcast address projection changed.");
      const reduced = own(output.sum()), grad = own(session.grad(reduced, [right])[0]);
      check((await grad.toArray()).every(value => value === rows * 2), "Receiving windows changed grouped gradients.");
    }
    return { elements: count, gpu: checkpoint(session) };
  } finally {
    optimizer?.close();
    for (const tensor of owned.reverse()) tensor.close();
  }
}

/** Nonuniform orientation fixtures distinguish the four matrix addressing modes. */
export async function checkGridMatrixOrientations(backend, Program) {
  const { float32TensorPayload, decodeTensorPayload } = await import("/execution/tensor-payload.js");
  const rows = 33, contraction = 3, columns = 65;
  for (const flags of [0, 1, 2, 3]) {
    const left = new Float32Array(rows * contraction), right = new Float32Array(contraction * columns);
    for (let row = 0; row < rows; row++) for (let t = 0; t < contraction; t++) {
      left[flags & 1 ? t * rows + row : row * contraction + t] = row % 5 + t + 1;
    }
    for (let t = 0; t < contraction; t++) for (let column = 0; column < columns; column++) {
      right[flags & 2 ? column * contraction + t : t * columns + column] = column % 7 - t;
    }
    const provenance = { operation: "matmul", source: "dispatch-qualification" };
    const shapes = [flags & 1 ? [contraction, rows] : [rows, contraction],
      flags & 2 ? [columns, contraction] : [contraction, columns], [rows, columns]];
    const values = shapes.map((shape, slot) => ({ slot, storageSlot: slot, shape, dtype: "float32", device: "webgpu",
      layout: "contiguous", source: slot === 2 ? "computed" : "binding", provenance }));
    const program = new Program(values, [{ kind: "matmul-f32", matrixFlags: flags, inputs: [0, 1], output: 2, provenance }], 2);
    await backend.prepare(program);
    const ticket = backend.execute(program, new Map([[0, { hostData: float32TensorPayload(left) }], [1, { hostData: float32TensorPayload(right) }]]), [false, false, true]);
    const allocations = await ticket.result; await ticket.drained;
    try {
      const read = backend.read(allocations.get(2), rows * columns, "float32");
      const actual = decodeTensorPayload(await read.result, "float32", rows * columns);
      await read.drained;
      for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
        let expected = 0;
        for (let t = 0; t < contraction; t++) expected += (row % 5 + t + 1) * (column % 7 - t);
        check(actual[row * columns + column] === expected, `Grid matrix orientation ${flags} changed at ${row}/${column}.`);
      }
    } finally { for (const allocation of allocations.values()) backend.release(allocation); }
    check(backend.diagnostics().ownedBufferBytes === 0, "Grid matrix fixture retained numerical storage.");
  }
  return { cases: 4, comparedWords: 4 * rows * columns };
}

/** Exact stored-bit sentinels also occupy rows after the first dispatch axis. */
export async function checkGridArithmetic(session) {
  const count = 2305, pattern = [0, 0x80000000, 1, 0x80000001, 0x3f800001, 0x3f7fffff,
    0x7f7fffff, 0xff7fffff, 0x7f800000, 0xff800000, 0x7fc00001];
  const left = Uint32Array.from({ length: count }, (_, i) => pattern[i % pattern.length]);
  const right = Uint32Array.from({ length: count }, (_, i) => pattern[(i * 3 + 1) % pattern.length]);
  const x = session.tensor(new Float32Array(left.buffer), { device: "webgpu", requiresGrad: true });
  const y = session.tensor(new Float32Array(right.buffer), { device: "webgpu" });
  let optimizer;
  try {
    for (const [operation, oracle] of [["add", exactAddition], ["mul", exactMultiplication]]) {
      const output = x[operation](y);
      try {
        const actual = new Uint32Array((await output.toArray()).buffer);
        check(actual.every((word, i) => equivalentBits(word, oracle(left[i], right[i]))), `Grid ${operation} stored bits changed.`);
      } finally { output.close(); }
    }
    x.grad = y;
    optimizer = session.sgd([x], { lr: .125 });
    optimizer.step();
    const actual = new Uint32Array((await x.toArray()).buffer);
    check(actual.every((word, i) => equivalentBits(word, exactCoefficientAddition(left[i], right[i], 0xbe000000))), "Grid FMA stored bits changed.");
    return { cases: 3, comparedWords: 3 * count };
  } finally { optimizer?.close(); x.close(); y.close(); }
}
