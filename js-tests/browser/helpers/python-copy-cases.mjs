// Consume the same independently generated cases as packaged Node/Pyodide.
export async function pythonCopyChecks() {
  const response = await fetch("/helpers/python-copy-oracle.json");
  if (!response.ok) throw new Error("Native copy fixtures could not be loaded.");
  const oracle = await response.json();
  if (oracle.copyCases.length === 0) throw new Error("No native copy cases.");
  return oracle.copyCases.map((fixture) => `
import torch, json, gc
def check_copy_fixture():
${fixture.source.trimEnd().split("\n").map((line) => `    ${line}`).join("\n")}
    assert report == json.loads(${JSON.stringify(JSON.stringify(fixture.expected))}), ${JSON.stringify(fixture.name)}
check_copy_fixture()
gc.collect()
`).join("\n");
}
