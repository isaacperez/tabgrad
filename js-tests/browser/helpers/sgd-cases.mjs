function nested(values, shape) {
  if (shape.length === 0) return values[0];
  const width = shape.slice(1).reduce((count, length) => count * length, 1);
  return shape.length === 1 ? values : Array.from({ length: shape[0] }, (_, index) => nested(values.slice(index * width, (index + 1) * width), shape.slice(1)));
}

async function tensorState(value, inspectVersion) {
  if (value === null) return null;
  const values = await value.toArray();
  const encoded = Array.from(new Uint32Array(values.buffer, values.byteOffset, values.length), (bits, index) => Number.isNaN(values[index]) ? "nan" : bits);
  return { bits: nested(encoded, value.shape), shape: [...value.shape], tracking: value.requiresGrad, version: inspectVersion(value) };
}

const DIRECT_RATES = new Map([["0.1", 0.1], ["0.", 0], ["float('inf')", Infinity], ["float('nan')", NaN], ["1e39", 1e39]]);

export function isDirectSGDCase(fixture) {
  return fixture.kind === "training" || fixture.kind === "groups" || fixture.kind === "alias" || fixture.kind === "closure"
    || ["reset-special-view-False", "reset-special-view-True", "reset-detachment-and-alias", "reset-view-progress", "retained-nonleaf-registration", "reset-leaf-old-history", "registered-incoming-gradient-owner", "repeated-gradient-reset"].includes(fixture.name)
    || (fixture.kind === "coefficient" && DIRECT_RATES.has(fixture.name.split("-").slice(2).join("-")));
}

/** Direct presentation uses the same frozen native observations, with its own binding types. */
export async function checkSGDCase(session, fixture, inspectVersion) {
  const state = (value) => tensorState(value, inspectVersion);
  const handles = new Set();
  const optimizers = [];
  const keep = (value) => { if (value !== null) handles.add(value); return value; };
  const tensor = (data, tracking = true, shape) => keep(session.tensor(data, { requiresGrad: tracking, ...(shape === undefined ? {} : { shape }) }));
  const optimizer = (parameters, options) => { const result = session.sgd(parameters, options); optimizers.push(result); return result; };
  const attempt = (call) => {
    try { call(); return "ok"; }
    catch (error) {
      if (error instanceof RangeError || ["SAVED_DETACHED", "INPLACE_VIEW", "CONSUMED_HISTORY"].includes(error?.code)) return "RuntimeError";
      throw error;
    }
  };
  let report;
  try {
    if (fixture.kind === "training") {
      const name = fixture.name.slice(9);
      const shape = name === "scalar" ? [] : name === "singleton" ? [1, 1, 1] : name === "matrix" ? [2, 2] : [2, 0];
      const p = tensor(name === "matrix" ? [1, 2, 3, 4] : name === "empty" ? [] : [2], true, shape);
      const alias = keep(p.view(name === "scalar" ? [] : name === "singleton" ? [1, 1, 1] : [name === "matrix" ? 4 : 0]));
      const opt = optimizer([p], { lr: 0.125 });
      const trace = [];
      for (let index = 0; index < 6; index += 1) {
        opt.zeroGrad(index % 2 === 0);
        const product = p.mul(p); const sum = product.add(p); const loss = sum.sum();
        loss.backward();
        loss.close(); sum.close(); product.close();
        const gradient = keep(p.grad);
        const returned = opt.step();
        trace.push([await state(p), await state(alias), await state(gradient), p.grad === gradient, returned === undefined, opt.state.size]);
        session.noGrad(() => p.copy_(p));
      }
      report = { trace };
    } else if (fixture.kind === "coefficient") {
      const [, presence, ...rate] = fixture.name.split("-");
      const p = tensor(presence === "empty" ? [] : presence === "absent" ? [1] : [50.29061508178711]);
      p.grad = presence === "absent" ? null : tensor(presence === "empty" ? [] : [502.9061279296875], false);
      const opt = optimizer([p]); opt.paramGroups[0].lr = DIRECT_RATES.get(rate.join("-"));
      report = { error: attempt(() => opt.step()), parameter: await state(p), gradient: await state(keep(p.grad)) };
    } else if (fixture.kind === "groups") {
      const p = tensor([2]); const q = tensor([4], false);
      p.grad = tensor([3], false); q.grad = tensor([5], false);
      const first = { params: [p, p], lr: 0.5, tag: "inert" };
      const warnings = [];
      const previous = console.warn;
      let opt;
      try {
        console.warn = () => warnings.push("UserWarning");
        opt = optimizer([first, { params: [], lr: -7 }, { params: [q], lr: -0.25 }]);
      } finally { console.warn = previous; }
      const oldGradient = keep(p.grad); const returned = opt.step(); first.lr = 0; opt.step();
      report = { p: await state(p), q: await state(q), same_group: opt.paramGroups[0] === first,
        same_param: first.params[0] === p, same_gradient: p.grad === oldGradient, warnings, state: opt.state.size, return: returned === undefined };
    } else if (fixture.kind === "alias") {
      const p = tensor([2]); const q = tensor([4]); p.grad = q; q.grad = p;
      optimizer([p, q], { lr: 0.5 }).step();
      report = { p: await state(p), q: await state(q), p_grad: p.grad === q, q_grad: q.grad === p };
    } else if (fixture.kind === "closure") {
      const p = tensor([2]); p.grad = tensor([3], false); const opt = optimizer([p], { lr: 0.5 });
      const sentinel = {}; const calls = [];
      let sameReturn; let restored;
      session.noGrad(() => {
        sameReturn = opt.step(() => { const result = p.add(p); calls.push(result.requiresGrad); result.close(); return sentinel; }) === sentinel;
        const result = p.add(p); restored = !result.requiresGrad; result.close();
      });
      const error = new Error("original"); let sameError;
      try { opt.step(() => { session.noGrad(() => p.copy_(tensor([8], false))); throw error; }); }
      catch (caught) { sameError = caught === error; }
      report = { calls, same_return: sameReturn, restored, same_error: sameError, parameter: await state(p) };
    } else if (fixture.name.startsWith("reset-special-view-")) {
      const p = tensor([2]); const q = tensor([4]); const x = tensor([3]); const first = tensor([7], false);
      const g = keep(session.noGrad(() => x.view([1]))); p.grad = first; q.grad = g;
      const opt = optimizer([p, q]);
      const error = fixture.name.endsWith("True") ? session.noGrad(() => attempt(() => opt.zeroGrad(false))) : attempt(() => opt.zeroGrad(false));
      report = { error, first: await state(first), gradient: await state(g), associated: q.grad === g };
    } else if (fixture.name === "reset-detachment-and-alias") {
      const p = tensor([2]); const x = tensor([3]); const g = keep(x.mul(x)); const alias = keep(g.view([1])); const saved = keep(g.mul(x));
      p.grad = g; optimizer([p]).zeroGrad(false);
      report = { gradient: await state(g), alias: await state(alias), associated: p.grad === g, error: attempt(() => saved.backward()) };
    } else if (fixture.name === "reset-view-progress") {
      const p = tensor([2]); const q = tensor([4]); const x = tensor([3]); const first = tensor([7], false);
      const bad = keep(keep(x.mul(x)).view([1])); p.grad = first; q.grad = bad;
      report = { error: attempt(() => optimizer([p, q]).zeroGrad(false)), first: await state(first), bad: await state(bad), first_same: p.grad === first, bad_same: q.grad === bad };
    } else if (fixture.name === "reset-leaf-old-history") {
      const p = tensor([2]); const g = tensor([3]); const constant = tensor([4], false);
      const old = keep(keep(g.mul(constant)).sum()); p.grad = g;
      optimizer([p]).zeroGrad(false);
      report = { first: attempt(() => old.backward()), second: attempt(() => old.backward()), gradient: await state(g), old_grad: await state(keep(g.grad)) };
    } else if (fixture.name === "registered-incoming-gradient-owner") {
      const p = tensor([2]); const seed = tensor([3], false, []); optimizer([p, seed]);
      const loss = p.sum(); loss.backward(seed); loss.close();
      const gradient = keep(p.grad); session.noGrad(() => gradient.copy_(tensor([7], false)));
      report = { seed: await state(seed), gradient: await state(gradient), same_gradient: p.grad === gradient };
    } else if (fixture.name === "repeated-gradient-reset") {
      const p = tensor([2]); const q = tensor([4]); const gradient = tensor([-0]); const alias = keep(gradient.view([1]));
      p.grad = gradient; q.grad = gradient; optimizer([p, q]).zeroGrad(false);
      report = { gradient: await state(gradient), alias: await state(alias), p_same: p.grad === gradient, q_same: q.grad === gradient };
    } else if (fixture.name === "retained-nonleaf-registration") {
      const x = tensor([2]); const p = keep(x.add(x)); const loss = p.sum(); loss.backward(undefined, { inputs: [p] }); loss.close();
      optimizer([p], { lr: 0.5 }).step();
      report = { parameter: await state(p), gradient: await state(keep(p.grad)) };
    } else throw new Error(`Unsupported direct fixture ${fixture.name}`);
    if (JSON.stringify(report) !== JSON.stringify(fixture.expected)) {
      throw new Error(`${fixture.name}: ${JSON.stringify(report)} expected ${JSON.stringify(fixture.expected)}`);
    }
  } finally {
    const failures = [];
    for (const opt of optimizers) { try { opt.close(); } catch (error) { failures.push(error); } }
    for (const handle of handles) { try { handle.close(); } catch (error) { failures.push(error); } }
    if (failures.length > 0) throw new AggregateError(failures, "SGD fixture cleanup failed.");
  }
}

/** Execute the maintained native sources through the real Python presentation. */
export function pythonSGDChecks(oracle) {
  return `
import torch, json, gc
def _check_sgd_native():
    for fixture in json.loads(${JSON.stringify(JSON.stringify(oracle.sgdCases))}):
        namespace = {'torch': torch, '_inspect_version': lambda value: inspect_sgd_version(value._handle)}
        try:
            exec(fixture['source'], namespace)
            assert namespace['report'] == fixture['expected'], (fixture['name'], namespace['report'], fixture['expected'])
        finally:
            namespace.clear()
            gc.collect()
        assert torch._runtime_session.diagnostics().liveTensorHandles == 0, (fixture['name'], torch._runtime_session.diagnostics().liveTensorHandles)
_check_sgd_native()
del _check_sgd_native
gc.collect()
assert torch._runtime_session.diagnostics().liveTensorHandles == 0
assert torch._runtime_session.diagnostics().liveDerivativeNodes == 0
assert torch._runtime_session.diagnostics().liveSavedValues == 0
`;
}
