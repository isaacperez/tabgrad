// Consume the same independently generated cases as packaged Node/Pyodide.
export function pythonCopyFixtureChecks(oracle, device = "cpu") {
  // These reset fixtures first install/reset persistent gradients using SGD.
  // That prerequisite is deliberately outside the GPU functional-copy domain.
  const cases = device === "webgpu"
    ? oracle.copyCases.filter(fixture => !fixture.name.startsWith("reset-view:")) : oracle.copyCases;
  return cases.map((fixture) => `
import torch, json, gc
def check_copy_fixture():
${fixture.source.replaceAll("dtype=torch.float32", `dtype=torch.float32, device=${JSON.stringify(device)}`).trimEnd().split("\n").map((line) => `    ${line}`).join("\n")}
    assert report == json.loads(${JSON.stringify(JSON.stringify(fixture.expected))}), ${JSON.stringify(fixture.name)}
check_copy_fixture()
gc.collect()
`).join("\n");
}

export async function pythonCopyChecks() {
  const response = await fetch("/helpers/python-copy-oracle.json");
  if (!response.ok) throw new Error("Native copy fixtures could not be loaded.");
  const oracle = await response.json();
  if (oracle.copyCases.length === 0) throw new Error("No native copy cases.");
  return pythonCopyFixtureChecks(oracle);
}
