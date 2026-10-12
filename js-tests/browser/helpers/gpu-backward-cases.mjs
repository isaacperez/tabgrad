import { completeRuntimeSession } from "/runtime/runtime.js";
import { getTestRuntimeSemanticOwnership, getTestRuntimeOwnership } from "/testing.js";

function check(condition, message) { if (!condition) throw new Error(message); }

function liveOwnership(session) {
  return { ...Object.fromEntries(Object.entries(getTestRuntimeSemanticOwnership(session))
    .filter(([name]) => !name.startsWith("collector"))), ...getTestRuntimeOwnership(session) };
}

async function accumulationCohort(session, { payload = 65, aliases = 0, width = 1, depth = 1, repetitions = 8 }) {
  const leaves = Array.from({ length: width }, () => session.tensor(new Float32Array(payload).fill(2),
    { device: "webgpu", requiresGrad: true }));
  const views = [];
  const checkpoints = [];
  let baseline;
  try {
    for (let iteration = 0; iteration < repetitions; iteration++) {
      let root;
      for (const leaf of leaves) {
        const product = leaf.mul(leaf), term = product.sum(); product.close();
        if (root === undefined) root = term;
        else { const next = root.add(term); root.close(); term.close(); root = next; }
      }
      for (let level = 1; level < depth; level++) {
        const zero = session.tensor([0], { shape: [], device: "webgpu" });
        const next = root.add(zero); root.close(); zero.close(); root = next;
      }
      root.backward(); root.close();
      for (const leaf of leaves) {
        const gradient = leaf.grad;
        check(gradient.device === "webgpu", "Backward gradient left the GPU");
        if (iteration === 0) for (let alias = 0; alias < aliases; alias++) views.push(gradient.view(gradient.shape));
        const values = await gradient.toArray();
        check(values.length === payload && values.every(value => value === 4 * (iteration + 1)), "Accumulation value mismatch");
        gradient.close();
      }
      await completeRuntimeSession(session);
      const current = liveOwnership(session);
      // Acquisition and the first in-place accumulation are different owner transitions.
      // Preserve both checkpoints; compare subsequent steady accumulation to its first state.
      if (iteration === 1) baseline = current;
      if (iteration > 1) check(JSON.stringify(current) === JSON.stringify(baseline), "Completed GPU accumulation retains history");
      if (iteration < 2 || iteration === repetitions - 1) checkpoints.push({ iteration, ownership: current });
      const diagnostics = session.diagnostics();
      check(diagnostics.liveSavedValues === 0 && diagnostics.liveDerivativeNodes === 0,
        `Completed backward derivative checkpoint ${JSON.stringify({ payload, aliases, width, depth, iteration,
          nodes: diagnostics.liveDerivativeNodes, saves: diagnostics.liveSavedValues, ownership: current })}`);
      check(diagnostics.liveRequestLeases === 0 && diagnostics.webgpu.pendingSubmissions === 0, "Drained backward keeps pending work");
      check(diagnostics.webgpu.ownedBufferBytes <= width * Math.max(1, payload) * 8,
        "Drained buffers exceed the two live numeric backings per parameter");
    }
    for (const view of views) {
      const values = await view.toArray();
      check(values.every(value => value === repetitions * 4), "Existing gradient aliases miss accumulation");
    }
    return checkpoints;
  } finally {
    for (const view of views) view.close();
    for (const leaf of leaves) { leaf.grad = null; leaf.close(); }
    await completeRuntimeSession(session);
    check(Object.values(liveOwnership(session)).every(value => value === 0), "GPU gradient cohort did not retire semantic owners");
    check(session.diagnostics().webgpu.ownedBufferBytes === 0, "GPU gradient cohort did not retire buffers");
  }
}

/** Independently vary one dimension, keeping the other fixed-owner conditions unchanged. */
export async function checkGpuBackwardResources(session) {
  const rows = [];
  for (const [dimension, values] of Object.entries({ payload: [0, 1, 65, 1024], aliases: [0, 1, 4],
    width: [1, 4, 16], depth: [1, 8, 32], repetitions: [1, 8, 32] })) {
    for (const value of values) rows.push({ dimension, value,
      checkpoints: await accumulationCohort(session, { [dimension]: value }) });
  }
  // A retained calculation owns a captured old value, unlike a gradient alias.
  const p = session.tensor([2], { device: "webgpu", requiresGrad: true });
  const firstProduct = p.mul(p), first = firstProduct.sum(); firstProduct.close(); first.backward(); first.close();
  const gradient = p.grad, zero = session.tensor([0], { device: "webgpu" }), captured = gradient.add(zero);
  const nextProduct = p.mul(p), next = nextProduct.sum(); nextProduct.close(); next.backward(); next.close();
  check((await captured.toArray())[0] === 4 && (await gradient.toArray())[0] === 8, "Retained old gradient calculation changed");
  captured.close(); gradient.close(); zero.close(); p.grad = null; p.close();
  await completeRuntimeSession(session);
  check(Object.values(liveOwnership(session)).every(value => value === 0), "Retained-read control did not retire");
  return rows;
}
