import { matrixCases, exactMatrixProduct, assertMatrixWords } from "./float32-matrix-oracle.mjs";
import { exactCoefficientAddition } from "./float32-coefficient-oracle.mjs";

const check = (condition, message) => { if (!condition) throw new Error(message); };
const assertions = { equal: (a, b, message) => check(Object.is(a, b), message ?? `${a} != ${b}`), ok: check };
const words = values => new Uint32Array(values.buffer, values.byteOffset, values.length);
const floats = bits => new Float32Array(bits.buffer, bits.byteOffset, bits.length);

/** Private backend qualification also reaches the otherwise unused both-transposed packet. */
export async function checkMatrixBackend(backend, Program) {
  let cases = 0, comparedWords = 0;
  const provenance = { operation: "matmul", source: "Tensor.matmul" };
  for (const fixture of matrixCases()) {
    const [m, k, n] = fixture.shape, flags = fixture.flags;
    const shapes = [flags & 1 ? [k, m] : [m, k], flags & 2 ? [n, k] : [k, n], [m, n]];
    const values = shapes.map((shape, slot) => ({ slot, storageSlot: slot, shape, dtype: "float32", device: "webgpu",
      layout: "contiguous", source: slot === 2 ? "computed" : "binding", provenance }));
    const program = new Program(values, [{ kind: "matmul-f32", matrixFlags: flags, inputs: [0, 1], output: 2, provenance }], 2);
    await backend.prepare(program);
    const ticket = backend.execute(program, new Map([[0, { hostData: floats(fixture.left) }],
      [1, { hostData: floats(fixture.right) }]]), [false, false, true]);
    const allocations = await ticket.result; await ticket.drained;
    try {
      const read = backend.read(allocations.get(2), m * n);
      const actual = read instanceof Float32Array ? read : await read.result;
      if (!(read instanceof Float32Array)) await read.drained;
      assertMatrixWords(words(actual), fixture.expected, assertions);
      cases++; comparedWords += actual.length;
    } finally { for (const allocation of new Set(allocations.values())) backend.release(allocation); }
    check(backend.diagnostics().ownedBufferBytes === 0, "Matrix backend retained a completed invocation");
  }
  return { cases, comparedWords, diagnostics: backend.diagnostics() };
}

/** Public forward and both ordinary VJPs use the independent integer oracle. */
export async function checkMatrixCases(session, device = "cpu") {
  let cases = 0, comparedWords = 0;
  for (const fixture of matrixCases().filter(fixture => fixture.flags === 0)) {
    const [m, k, n] = fixture.shape, owned = [];
    const tensor = (data, shape, requiresGrad = false) => {
      const value = session.tensor(data, { shape, device, requiresGrad }); owned.push(value); return value;
    };
    try {
      const a = tensor(floats(fixture.left), [m, k], true), b = tensor(floats(fixture.right), [k, n], true);
      const output = a.matmul(b); owned.push(output);
      check(output !== a && output !== b && output.device === device, `${fixture.name}: metadata/identity`);
      check(JSON.stringify(output.shape) === JSON.stringify([m, n]), `${fixture.name}: output shape`);
      assertMatrixWords(words(await output.toArray()), fixture.expected, assertions);
      const seed = tensor(new Float32Array(m * n).fill(0.5), [m, n]);
      const gradients = session.grad(output, [a, b], seed); owned.push(...gradients);
      const expected = [exactMatrixProduct(words(new Float32Array(m * n).fill(0.5)), fixture.right, [m, n, k], 2),
        exactMatrixProduct(fixture.left, words(new Float32Array(m * n).fill(0.5)), [k, m, n], 1)];
      for (let position = 0; position < 2; position++) {
        check(JSON.stringify(gradients[position].shape) === JSON.stringify(position === 0 ? [m, k] : [k, n]),
          `${fixture.name}: VJP shape ${position}`);
        assertMatrixWords(words(await gradients[position].toArray()), expected[position], assertions);
      }
      check(a.grad === null && b.grad === null, `${fixture.name}: functional grad modified persistent state`);
      cases++; comparedWords += fixture.expected.length + expected[0].length + expected[1].length;
    } finally { for (const value of owned) value.close(); }
  }
  return { cases, comparedWords };
}

/** Dimensions, repetitions and retained aliases vary independently at fixed-owner drain boundaries. */
export async function checkMatrixTraining(session, drain, inspectOwnership, device = "cpu") {
  const coordinates = [[2, 3, 2, 1, 0], [17, 3, 2, 1, 0], [2, 17, 2, 1, 0], [2, 3, 17, 1, 0],
    [2, 3, 2, 4, 0], [2, 3, 2, 16, 0], [2, 3, 2, 4, 4], [0, 3, 2, 4, 0],
    [2, 0, 3, 4, 0], [2, 3, 0, 4, 0]];
  const observations = [];
  for (const [m, k, n, repetitions, aliases] of coordinates) {
    await drain(session);
    const baseline = inspectOwnership(session), before = session.diagnostics();
    const xData = new Float32Array(m * k).fill(0.25), wData = new Float32Array(k * n).fill(0.125);
    const x = session.tensor(xData, { shape: [m, k], device });
    const w = session.tensor(wData, { shape: [k, n], device, requiresGrad: true });
    const views = Array.from({ length: aliases }, () => w.view([k, n]));
    const optimizer = session.sgd([{ params: [w], lr: 0.125 }]);
    let expected = words(wData).slice();
    const checkpoints = [];
    try {
      for (let repetition = 0; repetition < repetitions; repetition++) {
        optimizer.zeroGrad(false);
        const prediction = x.matmul(w), square = prediction.mul(prediction), loss = square.sum();
        try { loss.backward(); optimizer.step(); }
        finally { loss.close(); square.close(); prediction.close(); }
        const p = floats(exactMatrixProduct(words(xData), expected, [m, k, n]));
        const twice = Float32Array.from(p, value => 2 * value);
        const gradient = exactMatrixProduct(words(xData), words(twice), [k, m, n], 1);
        expected = expected.map((value, index) => exactCoefficientAddition(value, gradient[index], 0xbe000000));
        await drain(session);
        const diagnostics = session.diagnostics();
        // A live tracked parameter (and tracked views) owns derivative identities.
        // Completed saves must retire; fixed-owner metadata is compared below.
        check(diagnostics.liveSavedValues === 0,
          `Completed linear history survived a fixed-owner drain: ${JSON.stringify({ m, k, n, repetition,
            nodes: diagnostics.liveDerivativeNodes, saves: diagnostics.liveSavedValues })}`);
        checkpoints.push(inspectOwnership(session));
        if (device === "webgpu") check(diagnostics.webgpu.readbackBytes === before.webgpu.readbackBytes,
          "Linear backward/SGD read an intermediate to the host");
        if (repetition > 0) check(JSON.stringify(checkpoints.at(-1)) === JSON.stringify(checkpoints[0]),
          "Repeated linear steps accumulated fixed-owner resources");
      }
      assertMatrixWords(words(await w.toArray()), expected, assertions);
      for (const view of views) assertMatrixWords(words(await view.toArray()), expected, assertions);
      observations.push({ m, k, n, repetitions, aliases, checkpoint: checkpoints[0] });
    } finally {
      optimizer.close(); for (const view of views) view.close(); x.close(); w.close(); await drain(session);
    }
    check(JSON.stringify(inspectOwnership(session)) === JSON.stringify(baseline), "Linear cohort did not retire its owners");
  }
  return observations;
}

/** Concurrent demands and later mutations preserve captured values until independent drain. */
export async function checkMatrixPending(session, drain, inspectOwnership, device = "cpu") {
  const observations = [];
  for (const [m, k, n, pending, repetitions] of [[2, 3, 2, 1, 1], [65, 3, 2, 1, 1],
    [2, 17, 2, 1, 1], [2, 3, 17, 1, 1], [2, 3, 2, 4, 1], [2, 3, 2, 16, 1],
    [2, 3, 2, 4, 4], [2, 3, 2, 4, 16]]) {
    await drain(session);
    const baseline = inspectOwnership(session);
    const xData = new Float32Array(m * k).fill(0.25), oldData = new Float32Array(k * n).fill(0.125);
    const x = session.tensor(xData, { shape: [m, k], device });
    const w = session.tensor(oldData, { shape: [k, n], device });
    const replacement = session.tensor(new Float32Array(k * n).fill(0.25), { shape: [k, n], device });
    const oldExpected = exactMatrixProduct(words(xData), words(oldData), [m, k, n]);
    const futureExpected = exactMatrixProduct(words(xData), words(new Float32Array(k * n).fill(0.25)), [m, k, n]);
    let first;
    try {
      for (let repetition = 0; repetition < repetitions; repetition++) {
        // Restore old values before capturing a new set of demands.
        const reset = session.tensor(oldData, { shape: [k, n], device });
        try { w.copy_(reset); } finally { reset.close(); }
        const results = Array.from({ length: pending }, () => x.matmul(w));
        const views = results.map(value => value.view([m, n]));
        const reads = results.map(value => value.toArray());
        const future = (() => { w.copy_(replacement); return x.matmul(w); })();
        try {
          const values = await Promise.all(reads);
          for (const value of values) assertMatrixWords(words(value), oldExpected, assertions);
          assertMatrixWords(words(await future.toArray()), futureExpected, assertions);
          for (const view of views) assertMatrixWords(words(await view.toArray()), oldExpected, assertions);
        } finally { future.close(); for (const value of [...results, ...views]) value.close(); }
        await drain(session);
        const current = inspectOwnership(session);
        first ??= current;
        check(JSON.stringify(current) === JSON.stringify(first), "Pending matrix cohorts accumulated completed owners");
      }
      observations.push({ m, k, n, pending, repetitions, checkpoint: first });
    } finally { x.close(); w.close(); replacement.close(); await drain(session); }
    check(JSON.stringify(inspectOwnership(session)) === JSON.stringify(baseline), "Pending matrix owners did not retire");
  }
  return observations;
}
