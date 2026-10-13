import { pythonTensorDeviceSource } from "./python-tensor-device.mjs";

export function pythonMatrixChecks(oracle, device = "cpu") {
  if (!Array.isArray(oracle.matmulCases) || oracle.matmulCases.length === 0) throw new Error("Missing native matrix cases");
  return oracle.matmulCases.map(fixture => `
import torch, json, gc
def check_matrix_fixture():
${pythonTensorDeviceSource(fixture.source, device).trimEnd().split("\n").map(line => `    ${line}`).join("\n")}
    assert report == json.loads(${JSON.stringify(JSON.stringify(fixture.expected))}), (${JSON.stringify(fixture.name)}, report)
check_matrix_fixture()
gc.collect()
`).join("\n");
}
