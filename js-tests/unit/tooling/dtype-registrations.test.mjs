import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { TENSOR_DTYPES } from "../../../dist/shared/tensor-dtype.js";
import { COMPUTATION_SIGNATURES } from "../../../dist/execution/operation-contracts.js";
import { cpuKernel } from "../../../dist/backends/cpu/kernel-catalogue.js";
import { webGpuKernel } from "../../../dist/backends/webgpu/kernel-catalogue.js";
import { verifyDTypeRegistrations } from "../../../scripts/check-dtype-registrations.mjs";

const docs = await readFile(new URL("../../../docs/compatibility.md", import.meta.url), "utf8");

function without(lookup, excludedKind) {
  return kind => kind === excludedKind ? undefined : lookup(kind);
}

function changeAddCoverage(cpu, gpu) {
  const row = /^(\| \[`add`\]\([^)]+\) \|) [^|]+\| [^|]+\|$/m;
  assert.match(docs, row);
  return docs.replace(row, (_original, link) => `${link} ${cpu} | ${gpu} |`);
}

test("the public dtype table matches the compiled registrations", () => {
  verifyDTypeRegistrations(docs);
});

test("a documented arithmetic signature must exist on each promised backend", () => {
  assert.throws(() => verifyDTypeRegistrations(docs, { cpu: without(cpuKernel, "add-f16") }),
    /CPU add dtype registrations differ/);
  assert.throws(() => verifyDTypeRegistrations(docs, { webgpu: without(webGpuKernel, "add-f16") }),
    /WebGPU add dtype registrations differ/);
  const signatures = { ...COMPUTATION_SIGNATURES };
  delete signatures["add-f16"];
  assert.throws(() => verifyDTypeRegistrations(docs, { signatures }), /add dtype registrations differ/);
});

test("declared backend asymmetry passes but an undocumented registration fails", () => {
  const asymmetric = changeAddCoverage("`float32`, `float16`", "`float32`");
  verifyDTypeRegistrations(asymmetric, { webgpu: without(webGpuKernel, "add-f16") });
  assert.throws(() => verifyDTypeRegistrations(asymmetric), /WebGPU add dtype registrations differ/);
});

test("internal coefficient addition cannot stand in for public addition", () => {
  assert.ok(cpuKernel("add-alpha-f32"));
  assert.throws(() => verifyDTypeRegistrations(docs, { cpu: without(cpuKernel, "add-f32") }),
    /CPU add dtype registrations differ/);
});

test("a divergent registry name cannot replace another dtype in Python", () => {
  const definitions = { ...TENSOR_DTYPES, float16: { ...TENSOR_DTYPES.float16, name: "float32" } };
  assert.throws(() => verifyDTypeRegistrations(docs, { definitions }),
    /Dtype float16 must expose the same canonical name to Python/);
});

test("a missing or duplicate arithmetic row is never ignored", () => {
  const row = docs.split("\n").find(line => line.startsWith("| [`add`]("));
  assert.ok(row);
  assert.throws(() => verifyDTypeRegistrations(docs.replace(row + "\n", "")), /Missing arithmetic dtype row for add/);
  assert.throws(() => verifyDTypeRegistrations(docs.replace(row, `${row}\n${row}`)), /Duplicate arithmetic operation add/);
});

test("the documented arithmetic table must be visible and unique", () => {
  const section = docs.match(/^### Arithmetic\n[\s\S]*?(?=^### Storage and state$)/m)?.[0];
  assert.ok(section);
  for (const hidden of [`<!--\n${section}-->\n\n`, `~~~markdown\n${section}~~~~\n\n`]) {
    assert.throws(() => verifyDTypeRegistrations(docs.replace(section, hidden)), /one visible arithmetic dtype table/);
  }
  const conflicting = section.replace("`float16`", "`float128`");
  assert.throws(() => verifyDTypeRegistrations(docs.replace(section, section + conflicting)),
    /one visible arithmetic dtype table/);
});
