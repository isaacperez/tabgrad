import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { cpuKernel } from "../../../dist/backends/cpu/kernel-catalogue.js";
import { readOperationCompatibility, withOperationCompatibilityTables } from "../../../scripts/operation-compatibility.mjs";
import { verifyOperationCompatibilityRegistrations } from "../../../scripts/check-dtype-registrations.mjs";

const docs = await readFile(new URL("../../../docs/compatibility.md", import.meta.url), "utf8");
const fixture = () => ({
  schemaVersion: 1,
  operations: [{
    id: "add",
    name: "torch.add",
    module: "torch",
    aliases: ["Tensor.add", "+"],
    arithmetic: true,
    source: "docs/reference/python-tensors.md",
    fragment: "admit-addition",
    limits: "Same-device contiguous operands.",
    variants: [{
      inputs: ["float32", "float32"],
      result: "float32",
      cpu: { status: "supported", gradients: "first-order" },
      webgpu: { status: "supported", gradients: "first-order" },
    }],
  }],
});
const block = value => "<!-- tabgrad-operations\n" + JSON.stringify(value) + "\n-->\n";

test("historical Markdown and examples do not supply a compatibility inventory", () => {
  assert.equal(readOperationCompatibility("# Old compatibility\n"), undefined);
  const decoys = "```markdown\n" + block(fixture()) + "```\n\n<!-- Example\n" + block(fixture());
  assert.equal(readOperationCompatibility(decoys), undefined);
  assert.deepEqual(readOperationCompatibility(decoys + block(fixture())), fixture());
});

test("admit exactly one well-formed inventory and ownership-safe references", () => {
  assert.throws(() => readOperationCompatibility(block(fixture()).repeat(2)), /one operation compatibility inventory/);
  assert.throws(() => readOperationCompatibility("<!-- tabgrad-operations\n{}"), /unterminated/i);
  for (const change of [
    value => { value.schemaVersion = 2; },
    value => { value.operations[0].source = "docs/../README.md"; },
    value => { value.operations[0].name = "torch.sub"; },
    value => { value.operations[0].variants[0].cpu.status = "yes"; },
    value => { value.operations[0].variants[0].webgpu.gradients = "unknown"; },
  ]) {
    const value = fixture();
    change(value);
    assert.throws(() => readOperationCompatibility(block(value)), /compatibility/);
  }
});

test("operation identity and dtype tuples are unique per operation", () => {
  const duplicate = fixture();
  duplicate.operations.push(duplicate.operations[0]);
  assert.throws(() => readOperationCompatibility(block(duplicate)), /Duplicate compatibility operation/);
  const alternatives = fixture();
  const variants = alternatives.operations[0].variants;
  variants.push({ ...variants[0], cpu: { status: "unavailable", gradients: "not-applicable" } });
  assert.throws(() => readOperationCompatibility(block(alternatives)), /Duplicate compatibility signature/);
});

test("published arithmetic tuples match the implemented semantic and device catalogues", () => {
  const current = readOperationCompatibility(docs);
  assert.ok(current);
  verifyOperationCompatibilityRegistrations(current);
  assert.throws(() => verifyOperationCompatibilityRegistrations(current, {
    cpu: kind => kind === "sum-f32" ? undefined : cpuKernel(kind),
  }), /CPU sum compatibility registrations differ/);
  const mismatched = structuredClone(current);
  mismatched.operations.find(operation => operation.id === "matmul").variants[0].result = "float16";
  assert.throws(() => verifyOperationCompatibilityRegistrations(mismatched), /matmul compatibility registrations differ/);
});

test("the readable compatibility summaries are reproducible from the inventory", () => {
  const inventory = readOperationCompatibility(docs);
  assert.equal(withOperationCompatibilityTables(docs, inventory), docs);
  const drift = docs.replace("| `float32` | `float32` |", "| `float64` | `float64` |");
  assert.notEqual(drift, docs);
  assert.equal(withOperationCompatibilityTables(drift, inventory), docs);
});
