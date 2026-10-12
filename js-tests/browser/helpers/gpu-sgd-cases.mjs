import { coefficientTriples, exactCoefficientAddition } from "./float32-coefficient-oracle.mjs";
import { equivalentBits } from "./float32-addition-oracle.mjs";
import { completeRuntimeSession } from "/runtime/runtime.js";
import { getTestRuntimeOwnership, getTestRuntimeSemanticOwnership } from "/testing.js";

const bits = value => new Uint32Array(new Float32Array([value]).buffer)[0];
const value = word => new Float32Array(new Uint32Array([word]).buffer)[0];

function check(condition, message) { if (!condition) throw new Error(message); }

function liveOwnership(session) {
  return { ...Object.fromEntries(Object.entries(getTestRuntimeSemanticOwnership(session))
    .filter(([name]) => !name.startsWith("collector"))), ...getTestRuntimeOwnership(session) };
}

export function gpuSGDCheckpoint(session) {
  const diagnostic = session.diagnostics();
  return { ownership: liveOwnership(session), history: { nodes: diagnostic.liveDerivativeNodes,
    saves: diagnostic.liveSavedValues, operations: diagnostic.liveOperationRecords,
    materializations: diagnostic.liveMaterializationRecords, values: diagnostic.liveTensorValues },
    physical: { ownedBytes: diagnostic.webgpu.ownedBufferBytes,
      pending: diagnostic.webgpu.pendingSubmissions, unknown: diagnostic.webgpu.unknownCompletionBytes } };
}

function backwardCohort(session, parameters, depth) {
  let root;
  for (const p of parameters) {
    const product = p.mul(p), term = product.sum(); product.close();
    if (root === undefined) root = term;
    else { const next = root.add(term); root.close(); term.close(); root = next; }
  }
  for (let level = 1; level < depth; level++) {
    const zero = session.tensor([0], { device: "webgpu", shape: [] });
    const next = root.add(zero); root.close(); zero.close(); root = next;
  }
  try { root.backward(); }
  finally { root.close(); }
}

/** Physical mixed-device groups use ordinary per-parameter execution. */
export async function checkGpuSGDMixedDevices(session) {
  const p = session.tensor([2], { requiresGrad: true });
  const q = session.tensor([3], { device: "webgpu", requiresGrad: true });
  const pg = session.tensor([4]);
  const qg = session.tensor([6], { device: "webgpu" });
  let optimizer;
  try {
    p.grad = pg; q.grad = qg;
    optimizer = session.sgd([{ params: [p, q], lr: 0.125 }]);
    const before = session.diagnostics().webgpu;
    optimizer.step();
    await completeRuntimeSession(session);
    check(session.diagnostics().webgpu.readbackBytes === before.readbackBytes,
      "Mixed SGD transferred a GPU operand to CPU");
    check((await p.toArray())[0] === 1.5 && (await q.toArray())[0] === 2.25,
      "Mixed SGD update changed values");
    optimizer.zeroGrad(false);
    check(p.grad === pg && q.grad === qg && pg.device === "cpu" && qg.device === "webgpu",
      "Mixed SGD reset changed gradient identity or device");
    check(Object.is((await pg.toArray())[0], 0) && Object.is((await qg.toArray())[0], 0),
      "Mixed SGD reset did not write positive zero");
  } finally {
    optimizer?.close(); p.close(); q.close(); pg.close(); qg.close();
    await completeRuntimeSession(session);
  }
}

async function trainingCohort(session, { payload = 65, parameters = 1, groups = 1, duplicates = 1,
  aliases = 0, depth = 1, pending = 1, repetitions = 32 }) {
  const leaves = Array.from({ length: parameters }, () => session.tensor(new Float32Array(payload).fill(2),
    { device: "webgpu", requiresGrad: true }));
  const gradientHandles = [], views = [];
  const parameterGroups = Array.from({ length: groups }, (_, index) => ({
    params: index === 0 ? leaves.flatMap(p => new Array(duplicates).fill(p)) : [], lr: 0.125,
  }));
  const previousWarning = console.warn;
  let warnings = 0;
  let optimizer;
  try {
    // Repeated positions deliberately produce one native-compatible construction warning.
    if (duplicates > 1) console.warn = () => { warnings++; };
    optimizer = session.sgd(parameterGroups);
  } finally { console.warn = previousWarning; }
  check(warnings === Number(duplicates > 1), "Duplicate construction warning changed");
  let baseline, peakPendingCopies = 0;
  const checkpoints = [];
  try {
    for (let iteration = 0; iteration < repetitions; iteration++) {
      optimizer.zeroGrad(false);
      backwardCohort(session, leaves, depth);
      for (let index = 0; index < leaves.length; index++) {
        const gradient = leaves[index].grad;
        if (iteration === 0) {
          gradientHandles.push(gradient);
          for (let alias = 0; alias < aliases; alias++) {
            views.push(session.noGrad(() => leaves[index].view([payload])), gradient.view([payload]));
          }
        }
        check(gradient === gradientHandles[index], "SGD cycle replaced canonical leaf gradient");
      }
      optimizer.step();
      peakPendingCopies = Math.max(peakPendingCopies, getTestRuntimeOwnership(session).pendingCopies);
      // First two checkpoints establish ordinary acquisition and steady accumulation.
      // Later windows independently vary accepted pending work before observation.
      if (iteration < 2 || (iteration - 1) % pending === 0 || iteration === repetitions - 1) {
        for (const p of leaves) {
          const result = await p.toArray();
          check(result.length === payload && result.every(Number.isFinite), "SGD cycle result invalid");
        }
        await completeRuntimeSession(session);
        const current = gpuSGDCheckpoint(session);
        if (iteration === 1) baseline = current;
        if (iteration > 1) check(JSON.stringify(current) === JSON.stringify(baseline),
          `SGD completed cohort grew: ${JSON.stringify({ iteration, current, baseline })}`);
        check(current.history.nodes === 0 && current.history.saves === 0, "Completed SGD retained transient history");
        check(current.ownership.pendingCopies === 0 && current.ownership.undeliveredEffects === 0
          && current.physical.pending === 0 && current.physical.unknown === 0, "SGD checkpoint did not drain");
        check(current.physical.ownedBytes <= parameters * Math.max(1, payload) * 8,
          "SGD retained more than its current parameter and gradient backings");
        if (iteration < 2 || iteration === repetitions - 1) checkpoints.push({ iteration, ...current });
      }
    }
    check(peakPendingCopies > 0, "Pending-work control admitted no effects");
    for (let index = 0; index < views.length; index++) {
      const parameter = Math.floor(index / (aliases * 2));
      const expected = index % 2 === 0 ? leaves[parameter] : gradientHandles[parameter];
      check(JSON.stringify([...await views[index].toArray()]) === JSON.stringify([...await expected.toArray()]),
        "Held SGD alias lost current backing");
    }
    return { checkpoints, peakPendingCopies };
  } finally {
    optimizer.close();
    for (const tensor of [...views, ...gradientHandles, ...leaves]) tensor.close();
    await completeRuntimeSession(session);
    check(Object.values(liveOwnership(session)).every(value => value === 0), "SGD cohort left semantic owners");
    check(session.diagnostics().webgpu.ownedBufferBytes === 0, "SGD cohort left GPU buffers");
  }
}

/** One independent dimension per row; these are structural controls, not timings. */
export async function checkGpuSGDResources(session) {
  const rows = [];
  for (const [dimension, values] of Object.entries({ payload: [0, 1, 65, 4096], parameters: [1, 4, 16],
    groups: [1, 4, 16], duplicates: [1, 4, 16], aliases: [0, 1, 4], depth: [1, 8, 32],
    pending: [1, 4, 16], repetitions: [1, 8, 32] })) {
    for (const value of values) rows.push({ dimension, value, ...await trainingCohort(session, { [dimension]: value }) });
  }
  return rows;
}

/** Actual Python roots remain fixed across managed entry boundaries and collection. */
export function pythonSGDResourceSetup(config) {
  return `
import torch, gc, warnings, json
_sgd_cfg = json.loads(${JSON.stringify(JSON.stringify(config))})
_sgd_leaves = [torch.tensor([2.] * _sgd_cfg['payload'], dtype=torch.float32,
    device='webgpu', requires_grad=True) for _ in range(_sgd_cfg['parameters'])]
_sgd_gradients = []
_sgd_views = []
_sgd_groups = [dict(params=([p for p in _sgd_leaves for _ in range(_sgd_cfg['duplicates'])]
    if index == 0 else []), lr=0.125) for index in range(_sgd_cfg['groups'])]
with warnings.catch_warnings(record=True) as caught:
    warnings.simplefilter('always')
    _sgd_optimizer = torch.optim.SGD(_sgd_groups)
    assert len(caught) == int(_sgd_cfg['duplicates'] > 1)
del caught
def _sgd_train(count):
    for _ in range(count):
        _sgd_optimizer.zero_grad(False)
        root = None
        for p in _sgd_leaves:
            term = (p*p).sum()
            root = term if root is None else root + term
        for _ in range(1, _sgd_cfg['depth']):
            root = root + torch.tensor(0., dtype=torch.float32, device='webgpu')
        root.backward()
        if not _sgd_gradients:
            _sgd_gradients.extend(p.grad for p in _sgd_leaves)
            for p, gradient in zip(_sgd_leaves, _sgd_gradients):
                for _ in range(_sgd_cfg['aliases']):
                    with torch.no_grad(): _sgd_views.append(p.view(_sgd_cfg['payload']))
                    _sgd_views.append(gradient.view(_sgd_cfg['payload']))
        assert all(p.grad is gradient for p, gradient in zip(_sgd_leaves, _sgd_gradients))
        _sgd_optimizer.step()
        del root, term
    gc.collect()
`;
}

export const pythonSGDResourceCleanup = `
for index, view in enumerate(_sgd_views):
    parameter = index // (_sgd_cfg['aliases'] * 2)
    expected = _sgd_leaves[parameter] if index % 2 == 0 else _sgd_gradients[parameter]
    assert view.tolist() == expected.tolist()
if _sgd_views: del index, view, parameter, expected
del _sgd_optimizer, _sgd_groups, _sgd_leaves, _sgd_gradients, _sgd_views, _sgd_cfg, _sgd_train
gc.collect()
`;

export const pythonSGDCycleCollection = `
import torch, weakref, gc
def _drop_gpu_sgd_cycle():
    p = torch.tensor([2.], dtype=torch.float32, device='webgpu')
    q = torch.tensor([3.], dtype=torch.float32, device='webgpu')
    p.grad = q; q.grad = p
    group = {'params': [p, q], 'lr': 0.125}
    optimizer = torch.optim.SGD([group])
    group['cycle'] = optimizer
    witness = weakref.ref(optimizer)
    optimizer.step()
    return witness
_sgd_cycle_witness = _drop_gpu_sgd_cycle()
del _drop_gpu_sgd_cycle
gc.collect()
assert _sgd_cycle_witness() is None
del _sgd_cycle_witness
`;

async function pythonCheckpoint(client, nextCheckpoint) {
  const delivered = nextCheckpoint();
  await client.runPythonAsync("import _test_sgd_resource; _test_sgd_resource.report(torch._runtime_session)");
  return (await delivered).snapshot;
}

export async function checkPythonGpuSGDResources(client, nextCheckpoint) {
  const defaults = { payload: 65, parameters: 1, groups: 1, duplicates: 1, aliases: 0,
    depth: 1, pending: 1, repetitions: 32 };
  const rows = [];
  for (const [dimension, values] of Object.entries({ payload: [0, 1, 65, 4096], parameters: [1, 4, 16],
    groups: [1, 4, 16], duplicates: [1, 4, 16], aliases: [0, 1, 4], depth: [1, 8, 32],
    pending: [1, 4, 16], repetitions: [1, 8, 32] })) {
    for (const value of values) {
      const config = { ...defaults, [dimension]: value };
      await client.runPythonAsync(pythonSGDResourceSetup(config));
      let baseline;
      const checkpoints = [];
      try {
        let iteration = 0;
        while (iteration < config.repetitions) {
          const count = iteration < 2 ? 1 : Math.min(config.pending, config.repetitions - iteration);
          await client.runPythonAsync(`_sgd_train(${count})`);
          iteration += count;
          const current = await pythonCheckpoint(client, nextCheckpoint);
          if (iteration === 2) baseline = current;
          if (iteration > 2) check(JSON.stringify(current) === JSON.stringify(baseline),
            `Python SGD completed cohort grew: ${JSON.stringify({ dimension, value, iteration, current, baseline })}`);
          check(current.history.nodes === 0 && current.history.saves === 0, "Python SGD retained transient history");
          check(current.ownership.pendingCopies === 0 && current.ownership.undeliveredEffects === 0
            && current.physical.pending === 0 && current.physical.unknown === 0, "Managed SGD entry did not drain");
          check(current.physical.ownedBytes <= config.parameters * Math.max(1, config.payload) * 8,
            "Python SGD retained more than its parameter and gradient backings");
          if (iteration <= 2 || iteration === config.repetitions) checkpoints.push({ iteration, ...current });
        }
      } finally {
        await client.runPythonAsync(pythonSGDResourceCleanup);
        const retired = await pythonCheckpoint(client, nextCheckpoint);
        check(Object.values(retired.ownership).every(value => value === 0), "Python SGD collection left owners");
        check(retired.physical.ownedBytes === 0, "Python SGD collection left buffers");
      }
      rows.push({ dimension, value, checkpoints });
    }
  }
  await client.runPythonAsync(pythonSGDCycleCollection);
  const unrooted = await pythonCheckpoint(client, nextCheckpoint);
  check(Object.values(unrooted.ownership).every(value => value === 0) && unrooted.physical.ownedBytes === 0,
    "Actual unrooted Python SGD cycle remained live");
  return { cohorts: rows, unrooted };
}

async function coefficientCase(session, parameters, gradients, alpha) {
  const p = session.tensor(new Float32Array(new Uint32Array(parameters).buffer), { device: "webgpu" });
  const g = session.tensor(new Float32Array(new Uint32Array(gradients).buffer), { device: "webgpu" });
  let optimizer;
  try {
    p.grad = g;
    optimizer = session.sgd([p], { lr: 0 });
    // Ordinary mutable groups preserve native negative-rate and signed-zero cases.
    optimizer.paramGroups[0].lr = -value(alpha);
    optimizer.step();
    const result = await p.toArray();
    const actual = new Uint32Array(result.buffer, result.byteOffset, result.length);
    for (let index = 0; index < parameters.length; index++) {
      const expected = exactCoefficientAddition(parameters[index], gradients[index], alpha);
      if (!equivalentBits(actual[index], expected)) {
        throw new Error(`GPU SGD ${index}, p=${parameters[index].toString(16)}, g=${gradients[index].toString(16)}, alpha=${alpha.toString(16)}: ${actual[index].toString(16)} expected ${expected.toString(16)}`);
      }
    }
    if (actual.length !== parameters.length || p.grad !== g) throw new Error("SGD shape or gradient identity changed");
  } finally {
    optimizer?.close(); p.close(); g.close();
    await completeRuntimeSession(session);
  }
}

/** Actual ordinary SGD, including residuals that separate one and two roundings. */
export async function checkGpuSGDArithmetic(session) {
  const before = session.diagnostics().webgpu.kernelCalls;
  const triples = coefficientTriples();
  const groups = new Map();
  for (const [p, g, alpha] of triples) {
    let group = groups.get(alpha);
    if (group === undefined) { group = { parameters: [], gradients: [] }; groups.set(alpha, group); }
    group.parameters.push(p); group.gradients.push(g);
  }
  for (const [alpha, group] of groups) await coefficientCase(session, group.parameters, group.gradients, alpha);
  const alpha = bits(-0.1);
  for (const length of [0, 1, 63, 64, 65, 127, 128, 129]) {
    await coefficientCase(session, new Array(length).fill(bits(50.29061508178711)),
      new Array(length).fill(bits(502.9061279296875)), alpha);
  }
  const kernelCalls = session.diagnostics().webgpu.kernelCalls - before;
  if (kernelCalls !== groups.size + 7) throw new Error("SGD arithmetic dispatched repeated or skipped work");
  return { triples: triples.length, coefficientGroups: groups.size, kernelCalls,
    launchLengths: [0, 1, 63, 64, 65, 127, 128, 129] };
}
