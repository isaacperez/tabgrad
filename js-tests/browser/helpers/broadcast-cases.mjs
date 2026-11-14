import { pythonTensorDeviceSource } from "./python-tensor-device.mjs";

function check(condition, message) { if (!condition) throw new Error(message); }

function checkWords(actual, expected, name) {
  const words = new Uint32Array(actual.buffer, actual.byteOffset, actual.length);
  check(words.length === expected.length && words.every((word, index) => word === expected[index]), `${name}: float32 words differ`);
}

/** Exactly representable native controls; exceptional grouped totals have separate contracts. */
export async function checkBroadcastCases(session, fixtures, device = "cpu", compositions = []) {
  let cases = 0, comparedWords = 0;
  for (const fixture of fixtures) {
    const owned = [];
    try {
      const left = session.tensor(fixture.left, { shape: fixture.leftShape, device, requiresGrad: true }); owned.push(left);
      const right = session.tensor(fixture.right, { shape: fixture.rightShape, device, requiresGrad: true }); owned.push(right);
      const result = left[fixture.operation](right); owned.push(result);
      const count = fixture.expected.output.bits.length;
      const seed = session.tensor(Float32Array.from({ length: count }, (_, index) => fixture.negativeZeroSeed ? -0 : (index % 3 + 1) * 0.5),
        { shape: result.shape, device }); owned.push(seed);
      const gradients = session.grad(result, [left, right], seed); owned.push(...gradients);
      check(left.grad === null && right.grad === null, `${fixture.name}: functional gradient changed leaf state`);
      left.close(); right.close(); seed.close();
      for (const [value, expected] of [[result, fixture.expected.output], [gradients[0], fixture.expected.left], [gradients[1], fixture.expected.right]]) {
        check(JSON.stringify(value.shape) === JSON.stringify(expected.shape), `${fixture.name}: logical shape differs`);
        check(value.requiresGrad === expected.tracking, `${fixture.name}: tracking differs`);
        checkWords(await value.toArray(), expected.bits, fixture.name);
        comparedWords += expected.bits.length;
      }
      cases++;
    } finally { for (const value of owned) value.close(); }
  }
  for (const fixture of compositions) await checkComposition(session, fixture, device);
  await checkReceivingBoundaries(session, device);
  return { cases, comparedWords, compositions: compositions.length, receivingBoundaries: 4 };
}

async function checkReceivingBoundaries(session, device) {
  // Independently vary receiving groups and contributions. The largest case
  // crosses the GPU group-window boundary; 129/257 cross reduction stages.
  for (const [groups, terms] of [[1, 2], [5, 129], [5, 257], [65536, 2]]) {
    const owned = [];
    try {
      const input = session.tensor(new Float32Array(groups * terms), { shape: [terms, groups], device }); owned.push(input);
      const bias = session.tensor(new Float32Array(groups), { device, requiresGrad: true }); owned.push(bias);
      const output = input.add(bias); owned.push(output);
      const seed = session.tensor(new Float32Array(groups * terms).fill(1), { shape: output.shape, device }); owned.push(seed);
      const [gradient] = session.grad(output, [bias], seed); owned.push(gradient);
      const data = await gradient.toArray();
      check(data.length === groups && data.every(value => value === terms), `receiving ${groups}/${terms}: stage/window values differ`);
    } finally { for (const value of owned) value.close(); }
  }
  const owned = [];
  try {
    const input = session.tensor([0, 0, 0, 0], { device }); owned.push(input);
    const bias = session.tensor([0], { shape: [], device, requiresGrad: true }); owned.push(bias);
    const output = input.add(bias); owned.push(output);
    const seed = session.tensor([1e20, 1, -1e20, 1], { device }); owned.push(seed);
    const [gradient] = session.grad(output, [bias], seed); owned.push(gradient);
    check((await gradient.toArray())[0] === (device === "cpu" ? 0 : 2), "receiving changed its backend sum contract");
  } finally { for (const value of owned) value.close(); }
}

async function checkComposition(session, fixture, device) {
  const owned = [], optimizers = [];
  const keep = value => { owned.push(value); return value; };
  const tensor = (data, shape, requiresGrad = false) => keep(session.tensor(data, { shape, device, requiresGrad }));
  const array = async value => [...await value.toArray()];
  let report;
  try {
    if (fixture.name.startsWith("training:")) {
      const repetitions = Number(fixture.name.split(":")[1]);
      const x = tensor([1, 2, 3, 4], [2, 2]), w = tensor([1, 0, 0, 1], [2, 2], true), b = tensor([0.5, -0.5], [2], true);
      const alias = keep(b.view([1, 2])), optimizer = session.sgd([w, b], { lr: repetitions === 1 ? 0.125 : 0 });
      optimizers.push(optimizer);
      let checkpoint;
      for (let i = 0; i < repetitions; i++) {
        optimizer.zeroGrad();
        const product = x.matmul(w), prediction = product.add(b), square = prediction.mul(prediction), loss = square.sum();
        try { loss.backward(); optimizer.step(); await array(b); }
        finally { for (const value of [product, prediction, square, loss]) value.close(); }
        const diagnostics = session.diagnostics();
        check(diagnostics.liveSavedValues === 0, `${fixture.name}: saved operands survived completed backward`);
        const current = [diagnostics.liveTensorHandles, diagnostics.liveTensorValues, diagnostics.liveDerivativeNodes, diagnostics.liveOperationRecords];
        if (checkpoint !== undefined) check(JSON.stringify(current) === JSON.stringify(checkpoint), `${fixture.name}: fixed-owner history grew`);
        checkpoint = current;
      }
      const wg = keep(w.grad), bg = keep(b.grad);
      report = { w: await array(w), b: await array(b), alias: await array(alias), wg: await array(wg), bg: await array(bg) };
    } else if (fixture.name === "partial-version") {
      const x = tensor([1, 2, 3, 4, 5, 6], [2, 3], true), b = tensor([1, 2, 3], [3], true);
      const square = keep(x.mul(x)), prediction = keep(square.add(b)), out = keep(prediction.sum());
      session.noGrad(() => x.copy_(tensor([2, 3, 4, 5, 6, 7], [2, 3])));
      let failed = false;
      try { out.backward(); } catch (error) { check(error.code === "SAVED_VERSION_MISMATCH", "wrong saved-version failure"); failed = true; }
      report = { failed, x: x.grad === null, bias: await array(keep(b.grad)) };
    } else if (fixture.name.startsWith("view:")) {
      const shape = fixture.inputShape, target = fixture.receiverShape;
      const size = dimensions => dimensions.reduce((count, dimension) => count * dimension, 1);
      const x = tensor(new Float32Array(size(shape)).fill(1), shape), b = tensor(new Float32Array(size(target)), target, true);
      const seed = tensor(new Float32Array(size(shape)).fill(1), shape), out = keep(x.add(b));
      const [gradient] = session.grad(out, [b], seed); keep(gradient);
      const before = await array(gradient), tracked = tensor(new Float32Array(size(target)).fill(7), target, true);
      let rejected = false;
      try { gradient.copy_(tracked); }
      catch (error) { check(error.code === "INPLACE_VIEW", "wrong receiving view error"); rejected = true; }
      report = { before, rejected, after: await array(gradient), tracking: gradient.requiresGrad };
    } else {
      const x = tensor([2, 3], [2, 1], true), b = tensor([4, 5, 6], [1, 3], true), out = keep(x.mul(b));
      const seed = tensor([1, 1, 1, 1, 1, 1], [2, 3]);
      const [gx, gb, repeated] = session.grad(out, [x, b, b], seed); owned.push(gx, gb, repeated);
      session.noGrad(() => {
        seed.copy_(tensor([0, 0, 0, 0, 0, 0], [2, 3]));
        b.copy_(tensor([9, 9, 9], [1, 3]));
      });
      report = { output: await array(out), x: await array(gx), bias: await array(gb), repeat: await array(repeated) };
    }
    check(JSON.stringify(report) === JSON.stringify(fixture.expected), `${fixture.name}: composition differs: ${JSON.stringify(report)}`);
  } finally {
    for (const optimizer of optimizers) optimizer.close();
    for (const value of owned) value.close();
  }
}

/** Replay the native source, including incoming-object identity, in packaged Python. */
export function pythonBroadcastChecks(fixtures, device = "cpu", compositions = []) {
  return "import json, gc\n" + [...fixtures, ...compositions].map((fixture, index) => `
def check_broadcast_${index}():
${pythonTensorDeviceSource(fixture.source, device).trim().split("\n").map(line => `    ${line}`).join("\n")}
    expected = json.loads(${JSON.stringify(JSON.stringify(fixture.expected))})
    assert report == expected, (${JSON.stringify(fixture.name)}, report, expected)
check_broadcast_${index}()
del check_broadcast_${index}
`).join("\n") + "\ngc.collect()\n";
}
