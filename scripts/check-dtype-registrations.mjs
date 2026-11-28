import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { RuntimeSession, Tensor } from "../dist/index.js";
import { TENSOR_DTYPES } from "../dist/shared/tensor-dtype.js";
import { COMPUTATION_SIGNATURES } from "../dist/execution/operation-contracts.js";
import { cpuKernel } from "../dist/backends/cpu/kernel-catalogue.js";
import { webGpuKernel } from "../dist/backends/webgpu/kernel-catalogue.js";
import { compatibilitySignature, readOperationCompatibility, withOperationCompatibilityTables } from "./operation-compatibility.mjs";

const compatibility = new URL("../docs/compatibility.md", import.meta.url);
const dtypeCell = /^`[a-z][a-z0-9_]*`(?:, `[a-z][a-z0-9_]*`)*$/;

function visibleMarkdown(markdown) {
  const visible = [];
  let fence;
  let inComment = false;
  for (const line of markdown.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence !== undefined) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && marker[2].trim() === "") {
        fence = undefined;
      }
      visible.push("");
      continue;
    }
    if (inComment) {
      if (line.includes("-->")) inComment = false;
      visible.push("");
      continue;
    }
    if (marker && (marker[1][0] === "~" || !marker[2].includes("`"))) {
      fence = marker[1];
      visible.push("");
      continue;
    }
    const text = line.replace(/<!--.*?(?:-->|$)/g, comment => {
      inComment = !comment.endsWith("-->");
      return "";
    });
    const heading = /^ {0,3}(#{1,6})[ \t]+(.*)$/.exec(text);
    visible.push(heading ? `${heading[1]} ${heading[2].replace(/[ \t]+#+[ \t]*$/, "").trim()}` : text);
  }
  return visible.join("\n");
}

function documentedTypes(cell, operation, backend) {
  if (cell === "Unavailable" || cell === "Not evaluated") return [];
  assert.match(cell, dtypeCell, `Invalid dtype list for ${backend} ${operation}`);
  const types = cell.split(", ").map(type => type.slice(1, -1)).sort();
  assert.equal(new Set(types).size, types.length, `Duplicate dtype for ${backend} ${operation}`);
  return types;
}

function documentedArithmetic(markdown) {
  const sections = visibleMarkdown(markdown).split(/^## /m)
    .filter(section => section.toLowerCase().startsWith("tensor dtypes by operation\n"));
  assert.equal(sections.length, 1, "Expected one tensor dtype section");
  const operations = sections[0].split(/^### /m).filter(section =>
    /^(tensor operations|arithmetic)\n/i.test(section));
  assert.equal(operations.length, 1, "Expected one visible tensor operation dtype table");
  const [header, separator, ...rows] = operations[0].slice(operations[0].indexOf("\n") + 1).trim().split("\n");
  assert.equal(header, "| Operation | CPU | WebGPU |");
  assert.equal(separator, "| --- | --- | --- |");
  assert.ok(rows.length > 0, "Empty arithmetic dtype table");

  const expected = new Map();
  for (const row of rows) {
    const [start, label, cpu, webgpu, end, ...extra] = row.split("|").map(cell => cell.trim());
    const operation = /^\[`([a-z][a-z0-9_]*)`\]\([^)]+\)$/.exec(label)?.[1];
    assert.ok(operation && start === "" && end === "" && extra.length === 0, `Invalid arithmetic row: ${row}`);
    assert.ok(!expected.has(operation), `Duplicate arithmetic operation ${operation}`);
    expected.set(operation, {
      CPU: documentedTypes(cpu, operation, "CPU"),
      WebGPU: documentedTypes(webgpu, operation, "WebGPU"),
    });
  }
  return expected;
}

function isPublicArithmetic(signature) {
  // The optimizer's coefficient lowering shares the name "add" with Tensor.add.
  return signature.family.parameters !== "coefficient"
    && [Tensor.prototype, RuntimeSession.prototype].some(
      prototype => typeof Object.getOwnPropertyDescriptor(prototype, signature.operation)?.value === "function",
    );
}

export function verifyDTypeRegistrations(markdown, options) {
  const inventory = readOperationCompatibility(markdown);
  assert.ok(inventory, "Missing current operation compatibility inventory");
  documentedArithmetic(markdown);
  assert.equal(withOperationCompatibilityTables(markdown, inventory), markdown, "Operation compatibility summaries must match their inventory");
  verifyOperationCompatibilityRegistrations(inventory, options);
}

export function verifyOperationCompatibilityRegistrations(inventory, {
  definitions = TENSOR_DTYPES, signatures = COMPUTATION_SIGNATURES, cpu = cpuKernel, webgpu = webGpuKernel,
} = {}) {
  for (const [key, definition] of Object.entries(definitions)) {
    assert.equal(definition.name, key, `Dtype ${key} must expose the same canonical name to Python`);
  }
  const arithmetic = new Map(inventory.operations.filter(operation => operation.arithmetic).map(operation => [operation.id, operation]));
  for (const operation of inventory.operations) {
    for (const { inputs, result } of operation.variants) {
      for (const dtype of result === null ? inputs : [...inputs, result]) {
        assert.ok(Object.hasOwn(definitions, dtype), `Unknown compatibility dtype ${dtype} for ${operation.id}`);
      }
    }
  }
  for (const [device, label, lookup] of [["cpu", "CPU", cpu], ["webgpu", "WebGPU", webgpu]]) {
    const actual = new Map([...arithmetic.keys()].map(id => [id, new Set()]));
    for (const [kind, signature] of Object.entries(signatures)) {
      if (!isPublicArithmetic(signature) || !lookup(kind)) continue;
      const registered = actual.get(signature.operation);
      assert.ok(registered, `Missing arithmetic compatibility record for ${signature.operation}`);
      registered.add(compatibilitySignature(signature.types.inputs, signature.types.result));
    }
    for (const [id, { variants }] of arithmetic) {
      const expected = variants.filter(variant => variant[device].status === "supported")
        .map(variant => compatibilitySignature(variant.inputs, variant.result)).sort();
      assert.deepEqual([...actual.get(id)].sort(), expected, `${label} ${id} compatibility registrations differ from the inventory`);
    }
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  verifyDTypeRegistrations(await readFile(compatibility, "utf8"));
  console.log("Tensor dtype names and public arithmetic registrations match.");
}
