import { escapeHtml } from "./files.mjs";
import { admittedOperationDtypes } from "../../scripts/operation-compatibility.mjs";

const typeIds = types => [...new Set(types)].sort();
const dtypeSpan = type => `<code class="operation-dtype">${escapeHtml(type)}</code>`;
const statusText = { supported: "Supported", unavailable: "Unavailable", "not-evaluated": "Not evaluated" };
const gradientText = { "first-order": "First-order gradients", none: "Forward only", "not-applicable": "Not applicable" };

function variantTypes(variant) {
  return [...variant.inputs, ...(variant.result === null ? [] : [variant.result])];
}

function deviceSummary(variants, device, label) {
  const available = variants.filter(variant => variant[device].status === "supported");
  const types = admittedOperationDtypes(variants, device);
  const summary = types.length ? types.map(dtypeSpan).join("")
    : available.length ? "Supported"
      : variants.some(variant => variant[device].status === "not-evaluated") ? "Not evaluated" : "Unavailable";
  return `<span class="operation-device"><span class="operation-device-label">${label}</span>${summary}</span>`;
}

function operationDetails(operation, link) {
  const variants = operation.variants.map(variant => {
    const inputs = variant.inputs.length ? variant.inputs.join(", ") : "No tensor operands";
    const result = variant.result ?? "No tensor result";
    const coverage = device => {
      const { status, gradients } = variant[device];
      return statusText[status] + (status === "supported" && gradients !== "not-applicable" ? `, ${gradientText[gradients]}` : "");
    };
    return `<li><code>${escapeHtml(inputs)} → ${escapeHtml(result)}</code><span>CPU: ${coverage("cpu")} · GPU: ${coverage("webgpu")}</span></li>`;
  }).join("");
  return `<div class="operation-detail"><p>${escapeHtml(operation.limits)}</p><ul>${variants}</ul><a href="${escapeHtml(link)}">Read the <code>${escapeHtml(operation.name)}</code> reference →</a></div>`;
}

function operationRow(operation, index) {
  const reference = index.get(operation.source);
  if (!reference?.headings.includes(operation.fragment)) {
    throw new Error(`Invalid version-local operation compatibility reference: ${operation.id}`);
  }
  const link = `${reference.route}#${operation.fragment}`;
  const aliases = operation.aliases.length
    ? `<small>${operation.aliases.map(alias => `<code>${escapeHtml(alias)}</code>`).join(" · ")}</small>` : "";
  const dtypes = typeIds(operation.variants.filter(variant => variant.cpu.status === "supported" || variant.webgpu.status === "supported")
    .flatMap(variantTypes)).join(" ");
  const names = [operation.name, ...operation.aliases].join(" ");
  return `<details class="operation-row" id="operation-${operation.id}" data-operation-row data-names="${escapeHtml(names)}" data-dtypes="${escapeHtml(dtypes)}"><summary><span class="operation-name"><code>${escapeHtml(operation.name)}</code>${aliases}</span>${deviceSummary(operation.variants, "cpu", "CPU")}${deviceSummary(operation.variants, "webgpu", "GPU")}<span aria-hidden="true" class="operation-toggle"></span></summary>${operationDetails(operation, link)}</details>`;
}

function moduleLabel(module) {
  return escapeHtml(module === "torch.Tensor" ? "Tensor" : module);
}

/** Render the admitted operations into the document, before browser scripts run. */
export function renderOperationCompatibility(inventory, index) {
  const modules = new Map();
  for (const operation of inventory.operations) {
    if (!modules.has(operation.module)) modules.set(operation.module, []);
    modules.get(operation.module).push(operation);
  }
  const groups = [...modules].map(([name, operations]) => {
    const id = "operations-" + name.replaceAll(".", "-");
    return { id, name, rows: operations.map(operation => operationRow(operation, index)).join("") };
  });
  const types = typeIds(inventory.operations.flatMap(operation => operation.variants
    .filter(variant => variant.cpu.status === "supported" || variant.webgpu.status === "supported").flatMap(variantTypes)));
  const inputs = `<form class="operation-filters" data-operation-filters hidden><label>Find an operation<input type="search" data-operation-search placeholder="Try matmul"></label><label>Dtype<select data-operation-dtype><option value="">All dtypes</option>${types.map(type => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join("")}</select></label></form>`;
  const navigation = `<nav class="operation-modules" aria-label="PyTorch modules">${groups.map(group =>
    `<a href="#${group.id}" data-operation-link="${group.id}"><code>${moduleLabel(group.name)}</code></a>`).join("")}</nav>`;
  const tables = groups.map(group =>
    `<section class="operation-module" id="${group.id}" aria-labelledby="${group.id}-title" data-operation-module><h3 id="${group.id}-title"><code>${moduleLabel(group.name)}</code></h3><div class="operation-list"><div class="operation-columns" aria-hidden="true"><span>Operation</span><span>CPU dtypes</span><span>GPU dtypes</span></div>${group.rows}</div></section>`).join("");
  const markup = `<div class="operation-compatibility not-content" data-operation-compatibility><span id="arithmetic"></span><span id="tensor-operations"></span><span id="storage-and-state"></span>${inputs}${navigation}<p class="operation-count" data-operation-count aria-live="polite"></p>${tables}</div>`;
  return { markup, anchors: [...groups.flatMap(group => [group.id, group.id + "-title"]),
    ...inventory.operations.map(operation => "operation-" + operation.id)] };
}
