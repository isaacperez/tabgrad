/** Qualify public backward state against the same frozen native sources as Python. */
function nestedValues(values, shape) {
  if (shape.length === 0) return values[0];
  if (shape.length === 1) return values;
  const width = shape.slice(1).reduce((left, right) => left * right, 1);
  return Array.from({ length: shape[0] }, (_, index) => nestedValues(values.slice(index * width, (index + 1) * width), shape.slice(1)));
}

async function state(value) {
  return value === null ? null : { values: nestedValues([...await value.toArray()], value.shape), shape: [...value.shape], tracking: value.requiresGrad };
}

function attempt(call) {
  try { return { none: call() === undefined }; }
  catch (error) {
    if (["SAVED_VERSION_MISMATCH", "CONSUMED_HISTORY", "GRADIENT_NOT_TRACKED", "SHAPE_MISMATCH", "INPLACE_VIEW"].includes(error?.code)) return { error: "RuntimeError" };
    throw error;
  }
}

class BackwardCase {
  handles = [];
  constructor(session, inspectVersion) { this.session = session; this.inspectVersion = inspectVersion; }
  keep(handle) { this.handles.push(handle); return handle; }
  tensor(values, tracked = true, shape) {
    return this.keep(this.session.tensor(values, { requiresGrad: tracked, ...(shape === undefined ? {} : { shape }) }));
  }
  async close() {
    const failures = [];
    for (const handle of this.handles.reverse()) {
      try { handle.close(); } catch (error) { failures.push(error); }
    }
    if (failures.length !== 0) throw new AggregateError(failures, "Backward fixture cleanup failed.");
  }
  gradient(owner) { const handle = owner.grad; return handle === null ? null : this.keep(handle); }
}

const directBindingCases = new Set(["default", "unused", "used-unused", "repeated", "nonleaf", "nonleaf-leaf", "root", "untracked", "bad-shape"]);

/** Python normalization cases are qualified through the actual Python frontend. */
export function isDirectBackwardCase(fixture) {
  if (fixture.kind === 'setup' && fixture.name === 'setup-create-none') return false;
  return fixture.kind !== "binding" || directBindingCases.has(fixture.name.slice(8));
}

async function bindingCase(c, name) {
  if (!directBindingCases.has(name)) throw new Error(`Python-only backward fixture: ${name}`);
  const x = c.tensor([2, 3]); const unused = c.tensor([4, 5]); const plain = c.tensor([1, 1], false);
  const mid = c.keep(x.mul(x)); const out = c.keep(c.keep(mid.add(x)).sum());
  const inputs = name === "unused" ? [unused] : name === "used-unused" ? [x, unused]
    : name === "repeated" ? [x, x] : name === "nonleaf" ? [mid] : name === "nonleaf-leaf" ? [mid, x]
      : name === "root" ? [out] : name === "untracked" ? [plain] : [x];
  const call = attempt(() => out.backward(name === "bad-shape" ? plain : undefined,
    ["default", "none-sequence", "bad-shape"].includes(name) ? undefined : { inputs }));
  return { call, x: await state(c.gradient(x)), unused: await state(c.gradient(unused)), mid: await state(c.gradient(mid)), out: await state(c.gradient(out)) };
}

async function transitionCase(c, name) {
  const x = c.tensor([2, 3]);
  if (name === "accumulation-reset") {
    const first = c.keep(c.keep(x.mul(x)).sum()).backward();
    const g = c.gradient(x); const alias = c.keep(g.view([1, 2])); const initial = await state(g);
    c.keep(c.keep(x.mul(x)).sum()).backward(); const second = await state(g); const same = x.grad === g;
    c.session.noGrad(() => g.copy_(c.tensor([0, 0], false)));
    c.keep(c.keep(x.mul(x)).sum()).backward(); const reset = await state(g);
    x.grad = null; c.keep(c.keep(x.mul(x)).sum()).backward();
    return { none: first === undefined, initial, second, same, reset, new: await state(c.gradient(x)), old: await state(g), alias: await state(alias), different: x.grad !== g };
  }
  if (name === "assigned-tracked" || name === "assigned-own-view") {
    const g = name === "assigned-tracked" ? c.tensor([10, 20]) : c.keep(x.view([2]));
    x.grad = g; c.keep(c.keep(x.mul(x)).sum()).backward();
    return name === "assigned-tracked" ? { same: x.grad === g, gradient: await state(g) }
      : { same: x.grad === g, parameter: await state(x), gradient: await state(g) };
  }
  if (name === "shared-slot") {
    const y = c.tensor([5, 7]); const g = c.tensor([10, 20], false); x.grad = g; y.grad = g;
    c.keep(c.keep(c.keep(x.add(y)).add(y)).sum()).backward();
    return { xSame: x.grad === g, ySame: y.grad === g, gradient: await state(g) };
  }
  if (name === "partial-retry") {
    const y = c.tensor([5, 7]); const bad = c.keep(x.mul(x)); const good = c.keep(y.add(y)); const out = c.keep(c.keep(bad.add(good)).sum());
    c.session.noGrad(() => x.copy_(c.tensor([4, 5], false)));
    const first = attempt(() => out.backward()); const initial = await state(c.gradient(y));
    const second = attempt(() => out.backward()); const later = await state(c.gradient(y));
    c.keep(c.keep(x.add(y)).sum()).backward();
    return { first, initial, second, later, x: await state(c.gradient(x)), y: await state(c.gradient(y)) };
  }
  const mid = c.keep(["selected-failure", "functional-cutoff"].includes(name) ? x.mul(x) : x.add(x));
  const out = c.keep(mid.sum());
  if (name === "validation-retention") {
    const call = attempt(() => out.backward(undefined, { inputs: [mid, c.tensor([1, 1], false)] }));
    out.backward(); return { call, retained: await state(c.gradient(mid)), leaf: await state(c.gradient(x)) };
  }
  if (name === "selected-failure") {
    c.session.noGrad(() => x.copy_(c.tensor([4, 5], false)));
    const seed = c.tensor([1, 1], false); const call = attempt(() => mid.backward(seed, { inputs: [mid] }));
    return { call, retained: await state(c.gradient(mid)), leaf: await state(c.gradient(x)) };
  }
  out.backward(undefined, { inputs: [mid] }); const old = c.gradient(mid);
  if (name === "nonleaf-replacement") {
    out.backward(undefined, { inputs: [mid] });
    return { different: mid.grad !== old, old: await state(old), new: await state(c.gradient(mid)), leaf: await state(c.gradient(x)) };
  }
  if (name === "functional-cutoff") c.session.noGrad(() => x.copy_(c.tensor([4, 5], false)));
  const root = name === "functional-cutoff" ? c.keep(mid.sum()) : c.keep(c.keep(mid.add(mid)).sum());
  const [returned] = c.session.grad(root, [name === "functional-cutoff" ? mid : x]); c.keep(returned);
  return { different: mid.grad !== old, old: await state(old), new: await state(c.gradient(mid)), returned: await state(returned), leaf: await state(c.gradient(x)) };
}

async function shapeCase(c, name) {
  const [, kind, tracked] = name.split("-");
  const shapes = { scalar: [], singleton: [1, 1], matrix: [2, 2], empty: [0] };
  const data = { scalar: [2], singleton: [2], matrix: [1, 2, 3, 4], empty: [] };
  const x = c.tensor(data[kind], true, shapes[kind]); const seed = c.tensor(data[kind], tracked === "True", shapes[kind]);
  const call = attempt(() => c.keep(x.mul(x)).backward(seed));
  return { call, gradient: await state(c.gradient(x)), seed: await state(seed) };
}

async function seedAliasCase(c, name) {
  const [, , direct, tracked] = name.split("-");
  const x = c.tensor([2, 3]); const seed = c.tensor([5, 7], tracked === "True");
  const out = direct === "True" ? x : c.keep(x.view([2])); out.backward(seed); const g = c.gradient(x);
  c.session.noGrad(() => seed.copy_(c.tensor([9, 11], false))); const afterSeed = await state(g);
  c.session.noGrad(() => g.copy_(c.tensor([13, 17], false)));
  return { afterSeed, gradient: await state(g), seed: await state(seed), same: x.grad === g };
}

async function rebaseCase(c, kind) {
  const x = c.tensor([2, 3]); const y = c.tensor([5, 7]); const base = c.keep(x.add(x)); const mid = kind.startsWith("view") ? c.keep(base.view([2])) : base;
  const old = c.keep(c.keep(mid.add(mid)).sum()); c.keep(mid.sum()).backward(undefined, { inputs: [mid] }); const initial = await state(c.gradient(mid));
  const destination = kind === "viewwrite" ? mid : base;
  if (kind.endsWith("nograd")) c.session.noGrad(() => destination.copy_(y)); else destination.copy_(y);
  if (kind === "viewactiveforced") c.keep(mid.add(mid));
  const afterCopy = await state(c.gradient(mid)); const oldCall = attempt(() => old.backward()); const afterOld = await state(c.gradient(mid));
  const freshCall = attempt(() => c.keep(mid.sum()).backward());
  return { initial, afterCopy, oldCall, afterOld, freshCall, afterFresh: await state(c.gradient(mid)), leaf: await state(c.gradient(x)), source: await state(c.gradient(y)) };
}

async function acquisitionCase(c, name) {
  const tracked = name.endsWith('-True');
  const kind = name.slice('acquisition-'.length, name.lastIndexOf('-'));
  const singleton = kind === 'singleton-sum';
  const scalar = kind === 'sum' || singleton;
  const x = c.tensor(singleton ? [2] : [2, 3]); const y = c.tensor(singleton ? [5] : [5, 7]);
  const seed = c.tensor(scalar ? [5] : [5, 7], tracked, scalar ? [] : [2]);
  const out = kind === 'add' ? c.keep(x.add(y)) : kind === 'repeated' ? c.keep(x.add(x))
    : kind === 'triple' ? c.keep(c.keep(x.add(x)).add(x)) : kind === 'multiply' ? c.keep(x.mul(y))
      : kind === 'square' ? c.keep(x.mul(x)) : kind === 'add-view' ? c.keep(c.keep(x.add(y)).view([2]))
        : kind === 'views-add' ? c.keep(c.keep(x.view([2])).add(c.keep(y.view([2])))) : c.keep(x.sum());
  out.backward(seed); const gx = c.gradient(x); const gy = c.gradient(y);
  if (c.inspectVersion !== undefined) {
    // Frozen wheel controls use private diagnostics; these are not public API fields.
    const versions = { add: [1, 1], repeated: [0, null], triple: [1, null], multiply: [0, 0],
      square: [1, null], 'add-view': [1, 0], 'views-add': [0, 0], sum: [1, null], 'singleton-sum': [1, null] };
    const actual = [c.inspectVersion(gx), gy === null ? null : c.inspectVersion(gy)];
    if (JSON.stringify(actual) !== JSON.stringify(versions[kind])) throw new Error(`${name}: native initial versions differ: ${JSON.stringify(actual)}`);
  }
  const initialX = await state(gx); const initialY = await state(gy);
  c.session.noGrad(() => seed.copy_(c.tensor(scalar ? [9] : [9, 9], false, scalar ? [] : [2])));
  const afterSeedX = await state(gx); const afterSeedY = await state(gy);
  c.session.noGrad(() => gx.copy_(c.tensor(singleton ? [13] : [13, 13], false)));
  return { initialX, initialY, afterSeedX, afterSeedY, afterX: await state(gx), afterY: await state(gy), seed: await state(seed) };
}

async function specialViewCase(c, name) {
  const [, , direct, selected] = name.split('-');
  const x = c.tensor([2, 3]); const view = c.keep(c.session.noGrad(() => x.view([2])));
  const out = direct === 'True' ? view : c.keep(view.sum());
  const call = attempt(() => out.backward(direct === 'True' ? c.tensor([1, 1], false) : undefined,
    selected === 'True' ? { inputs: [view] } : undefined));
  return { call, base: await state(c.gradient(x)), view: await state(c.gradient(view)), tracking: view.requiresGrad };
}

async function setupCase(c, name) {
  const x = c.tensor([2, 3]); const mid = c.keep(x.add(x)); const out = c.keep(mid.sum());
  const plain = c.keep(c.session.noGrad(() => mid.sum()));
  let call;
  if (name === 'setup-invalid-target') {
    try { out.backward(undefined, { inputs: [mid, 1] }); call = { none: true }; }
    catch (error) { if (error.code !== 'INVALID_TENSOR') throw error; call = { error: 'RuntimeError' }; }
  } else if (name === 'setup-seed-shape') call = attempt(() => out.backward(c.tensor([1, 1], false), { inputs: [mid] }));
  else if (name === 'setup-root-tracking') call = attempt(() => plain.backward(c.tensor([1], false, []), { inputs: [mid] }));
  else throw new Error(`Python-only setup fixture ${name}`);
  c.keep(mid.sum()).backward();
  return { call, retained: await state(c.gradient(mid)), leaf: await state(c.gradient(x)) };
}

export async function checkBackwardCase(session, fixture, inspectVersion) {
  const c = new BackwardCase(session, inspectVersion);
  try {
    const report = fixture.kind === "binding" ? await bindingCase(c, fixture.name.slice(8))
      : fixture.kind === "transition" ? await transitionCase(c, fixture.name)
        : fixture.kind === "shape" ? await shapeCase(c, fixture.name)
          : fixture.kind === "seed-alias" ? await seedAliasCase(c, fixture.name)
            : fixture.kind === 'setup' ? await setupCase(c, fixture.name)
              : fixture.kind === 'special-view' ? await specialViewCase(c, fixture.name)
              : fixture.kind === 'acquisition' ? await acquisitionCase(c, fixture.name)
              : await rebaseCase(c, fixture.name.slice(7));
    if (JSON.stringify(report) !== JSON.stringify(fixture.expected)) {
      throw new Error(`${fixture.name}: backward differs from native: ${JSON.stringify(report)} expected ${JSON.stringify(fixture.expected)}`);
    }
  } finally { await c.close(); }
}

export function pythonBackwardChecks(oracle) {
  return oracle.backwardCases.map(fixture => `
import torch, json, gc
def check_backward_fixture():
${fixture.source.trimEnd().split("\n").map(line => `    ${line}`).join("\n")}
    assert report == json.loads(${JSON.stringify(JSON.stringify(fixture.expected))}), ${JSON.stringify(fixture.name)}
check_backward_fixture()
gc.collect()
assert torch._runtime_session.diagnostics().liveTensorHandles == 0
assert torch._runtime_session.diagnostics().liveSavedValues == 0
assert torch._runtime_session.diagnostics().liveDerivativeNodes == 0
`).join("\n");
}
