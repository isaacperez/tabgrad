/** Data admitted from the release's compatibility Markdown. */
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const startMarker = "<!-- tabgrad-operations";
const endMarker = "-->";
const identifier = /^[a-z][a-z0-9_]*$/;
const qualifiedName = /^torch(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const callableName = /^(?:torch|Tensor)(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;
const referencePath = /^docs\/reference\/[a-z][a-z0-9-]*\.md$/;
const fragmentName = /^[a-z0-9_-]+$/;
const statuses = new Set(["supported", "unavailable", "not-evaluated"]);
const gradientModes = new Set(["first-order", "none", "not-applicable"]);

function matchesFields(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function shortText(value) {
  return typeof value === "string" && value.trim() === value && value.length > 0
    && value.length <= 280 && !/[\u0000-\u001f]/u.test(value);
}

function validDevice(value) {
  return matchesFields(value, ["status", "gradients"]) && statuses.has(value.status)
    && gradientModes.has(value.gradients) && (value.status === "supported" || value.gradients === "not-applicable");
}

function markerBodies(markdown) {
  const bodies = [];
  let active;
  let fence;
  let comment = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (active !== undefined) {
      if (line === endMarker) {
        bodies.push(active.join("\n"));
        active = undefined;
      } else {
        if (line.includes(endMarker)) throw new Error("Invalid operation compatibility comment boundary");
        active.push(line);
      }
      continue;
    }
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence !== undefined) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && marker[2].trim() === "") {
        fence = undefined;
      }
    } else if (comment) {
      if (line.includes(endMarker)) comment = false;
    } else if (marker && (marker[1][0] === "~" || !marker[2].includes("`"))) {
      fence = marker[1];
    } else if (line === startMarker) {
      active = [];
    } else {
      const match = /<!--(?:(?!-->).)*$/.exec(line);
      comment = match !== null && !match[0].includes(endMarker);
    }
  }
  if (active !== undefined) throw new Error("Unterminated operation compatibility inventory");
  if (bodies.length > 1) throw new Error("Expected one operation compatibility inventory");
  return bodies;
}

function validateOperation(operation) {
  if (!matchesFields(operation, ["id", "name", "module", "aliases", "arithmetic", "source", "fragment", "limits", "variants"])
    || typeof operation.id !== "string" || !identifier.test(operation.id)
    || typeof operation.name !== "string" || !callableName.test(operation.name)
    || typeof operation.module !== "string" || !qualifiedName.test(operation.module)
    || !Array.isArray(operation.aliases) || !operation.aliases.every(shortText)
    || new Set(operation.aliases).size !== operation.aliases.length || operation.aliases.includes(operation.name)
    || typeof operation.arithmetic !== "boolean" || typeof operation.source !== "string" || !referencePath.test(operation.source)
    || typeof operation.fragment !== "string" || !fragmentName.test(operation.fragment) || !shortText(operation.limits)
    || !Array.isArray(operation.variants) || !operation.variants.length) throw new Error("Invalid operation compatibility record");
  if (operation.arithmetic && (operation.module !== "torch" || operation.name !== `torch.${operation.id}`)) {
    throw new Error(`Invalid arithmetic compatibility name: ${operation.id}`);
  }

  const signatures = new Set();
  for (const variant of operation.variants) {
    if (!matchesFields(variant, ["inputs", "result", "cpu", "webgpu"])
      || !Array.isArray(variant.inputs) || !variant.inputs.every(dtype => typeof dtype === "string" && identifier.test(dtype))
      || variant.result !== null && (typeof variant.result !== "string" || !identifier.test(variant.result))
      || operation.arithmetic && (variant.inputs.length === 0 || variant.result === null)
      || !validDevice(variant.cpu) || !validDevice(variant.webgpu)) {
      throw new Error("Invalid operation compatibility signature");
    }
    const key = compatibilitySignature(variant.inputs, variant.result);
    if (signatures.has(key)) throw new Error(`Duplicate compatibility signature: ${operation.id}`);
    signatures.add(key);
  }
}

export function compatibilitySignature(inputs, result) {
  return JSON.stringify([inputs, result]);
}

export function admittedOperationDtypes(variants, device) {
  return [...new Set(variants.filter(variant => variant[device].status === "supported")
    .flatMap(variant => variant.inputs.length ? variant.inputs : variant.result === null ? [] : [variant.result]))];
}

function summaryCell(variants, device) {
  const dtypes = admittedOperationDtypes(variants, device);
  if (dtypes.length) return dtypes.map(type => `\`${type}\``).join(", ");
  if (variants.some(variant => variant[device].status === "supported")) return "Supported";
  return variants.some(variant => variant[device].status === "not-evaluated") ? "Not evaluated" : "Unavailable";
}

function summaryTable(title, operations) {
  const rows = operations.map(operation => {
    const label = operation.arithmetic ? operation.id : operation.name;
    const link = operation.source.slice("docs/".length) + "#" + operation.fragment;
    return `| [\`${label}\`](${link}) | ${summaryCell(operation.variants, "cpu")} | ${summaryCell(operation.variants, "webgpu")} |`;
  });
  return `### ${title}\n\n| Operation | CPU | WebGPU |\n| --- | --- | --- |\n${rows.join("\n")}\n`;
}

/** Rebuild the GitHub-readable summaries from the retained data in the same file. */
export function withOperationCompatibilityTables(markdown, inventory) {
  const summaries = /^### Arithmetic\n\n(?:\|[^\n]*\n)+\n### Storage and state\n\n(?:\|[^\n]*\n)+/gm;
  if ([...markdown.matchAll(summaries)].length !== 1) throw new Error("Missing or repeated operation compatibility summaries");
  const arithmetic = inventory.operations.filter(operation => operation.arithmetic);
  const others = inventory.operations.filter(operation => !operation.arithmetic);
  return markdown.replace(summaries, () => summaryTable("Arithmetic", arithmetic) + "\n" + summaryTable("Storage and state", others));
}

/** A missing inventory lets an older Git baseline keep its original page. */
export function readOperationCompatibility(markdown) {
  const [body] = markerBodies(markdown);
  if (body === undefined) return undefined;
  let value;
  try {
    value = JSON.parse(body);
  } catch (error) {
    throw new Error("Invalid operation compatibility JSON", { cause: error });
  }
  if (!matchesFields(value, ["schemaVersion", "operations"]) || value.schemaVersion !== 1
    || !Array.isArray(value.operations) || !value.operations.length) throw new Error("Invalid operation compatibility inventory");

  const identities = new Set();
  for (const operation of value.operations) {
    validateOperation(operation);
    if (identities.has(operation.id)) throw new Error(`Duplicate compatibility operation: ${operation.id}`);
    identities.add(operation.id);
  }
  return value;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv.length !== 3 || process.argv[2] !== "--sync-tables") throw new Error("Use: node scripts/operation-compatibility.mjs --sync-tables");
  const path = new URL("../docs/compatibility.md", import.meta.url);
  const markdown = await readFile(path, "utf8");
  const inventory = readOperationCompatibility(markdown);
  if (!inventory) throw new Error("Missing current operation compatibility inventory");
  const updated = withOperationCompatibilityTables(markdown, inventory);
  if (updated !== markdown) await writeFile(path, updated);
}
