function flatten(data) { return Array.isArray(data) ? data.flat(Infinity) : [data]; }

export async function loadGradientProgressOracle() {
  const response = await fetch("/helpers/python-copy-oracle.json");
  if (!response.ok) throw new Error(`Progress oracle request failed: ${response.status}`);
  const oracle = await response.json();
  if (oracle.gradientProgressCases.length === 0) throw new Error("Empty progress oracle.");
  return oracle;
}

function keepHandle(handles, handle) { handles.push(handle); return handle; }

function closeHandles(handles) {
  const failures = [];
  for (const handle of handles) {
    try { handle.close(); } catch (error) { failures.push(error); }
  }
  if (failures.length !== 0) throw new AggregateError(failures, "Progress fixture cleanup failed.");
}

/** Run the native progress matrix through real handles; no internal node order is observed. */
export async function checkGradientProgress(session, fixture) {
  const c = fixture.config;
  const shape = [];
  let level = c.x_data;
  while (Array.isArray(level)) { shape.push(level.length); level = level[0]; }
  const handles = [];
  try {
    const x = keepHandle(handles, session.tensor(flatten(c.x_data), { shape, requiresGrad: true }));
    const y = keepHandle(handles, session.tensor(flatten(c.y_data), { shape, requiresGrad: true }));
    const shared = c.kind === "shared" ? keepHandle(handles, x.mul(x)) : y;
    let good;
    if (c.good_first) good = keepHandle(handles, c.good_saved ? shared.mul(shared) : shared.add(shared));
    const bad = keepHandle(handles, c.kind === "shared" ? shared.mul(y) : c.kind === "pruned-save" ? x.mul(y) : x.mul(x));
    if (!c.good_first) good = keepHandle(handles, c.good_saved ? shared.mul(shared) : shared.add(shared));
    if (c.kind === "view-copy" || c.kind === "direct-copy") {
      good = keepHandle(handles, y.add(y));
      if (c.kind === "view-copy") good = keepHandle(handles, good.view(shape));
      good.copy_(y);
    }
    let root = keepHandle(handles, c.swap_operands ? good.add(bad) : bad.add(good));
    if (c.repeated) root = keepHandle(handles, root.add(good));
    root = keepHandle(handles, root.sum());
    const changed = c.kind === "shared" ? y : x;
    // A self-copy changes the same native mutation version without changing numbers.
    session.noGrad(() => changed.copy_(changed));
    const seed = keepHandle(handles, session.tensor(flatten(c.seed_data), { shape }));
    const tensors = { root, good, bad, shared, x, y };
    for (let index = 0; index < c.calls.length; index++) {
      const [output, inputs] = c.calls[index];
      const expected = fixture.expected[index];
      let results;
      let failure;
      try { results = session.grad(tensors[output], inputs.map(name => tensors[name]), output === "root" ? undefined : seed); }
      catch (error) { failure = error; }
      if (expected.error !== undefined) {
        if (failure?.code !== expected.error) {
          for (const value of results ?? []) value.close();
          throw new Error(`${fixture.name} call ${index}: expected ${expected.error}, received ${failure?.code ?? "success"}`);
        }
        continue;
      }
      if (failure !== undefined) throw failure;
      try {
        if (results.length !== expected.values.length) throw new Error("Native gradient result count differs.");
        for (let result = 0; result < results.length; result++) {
          const value = results[result];
          const observed = [...await value.toArray()];
          if (JSON.stringify(observed) !== JSON.stringify(flatten(expected.values[result]))
              || JSON.stringify(value.shape) !== JSON.stringify(expected.shapes[result])
              || value.requiresGrad !== expected.tracking[result]) {
            throw new Error(`${fixture.name} call ${index}: gradient differs from native`);
          }
        }
      } finally { for (const value of results) value.close(); }
    }
  } finally { closeHandles(handles.reverse()); }
}

/** Shared fixture source observes the same Python calls and error categories in Pyodide. */
export function pythonGradientProgressChecks(oracle) {
  return oracle.gradientProgressCases.map(fixture => `
import torch, json, gc
def check_gradient_progress_fixture():
${fixture.source.trimEnd().split("\n").map(line => `    ${line}`).join("\n")}
    assert report == json.loads(${JSON.stringify(JSON.stringify(fixture.expected))}), ${JSON.stringify(fixture.name)}
check_gradient_progress_fixture()
gc.collect()
assert torch._runtime_session.diagnostics().liveSavedValues == 0
assert torch._runtime_session.diagnostics().liveDerivativeNodes == 0
`).join("\n");
}
