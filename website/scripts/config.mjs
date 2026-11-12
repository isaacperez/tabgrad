import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const websiteRoot = fileURLToPath(new URL("..", import.meta.url));
export const repositoryRoot = resolve(websiteRoot, "..");
export const repositoryUrl = "https://github.com/isaacperez/tabgrad";
export const packageUrl = "https://www.npmjs.com/package/@tabgrad/tabgrad";
export const maintainerContact = { label: "@isaperbor", url: "https://x.com/isaperbor", linkedInUrl: "https://www.linkedin.com/in/isaperbor/" };
export const supportUrl = "https://buymeacoffee.com/isaperbor";
export const runtimeVersion = "0.3.0";
export const pyodideVersion = "314.0.6";

export const documentDirectories = ["concepts", "architecture", "components", "flows"];
// Editorial summaries for chapters whose opening paragraph records acceptance
// rather than introducing the topic. Other pages use their Markdown introduction.
export const documentDescriptions = {
  "docs/architecture/browser-distribution.md": "How Tabgrad keeps JavaScript, Python, workers and numerical assets together in one versioned browser distribution.",
  "docs/architecture/central-decision.md": "Why Tabgrad shares one semantic runtime across Python and JavaScript, with separate CPU and GPU numerical backends.",
  "docs/architecture/python-observation.md": "How ordinary Python calls wait for GPU results while a separate worker keeps the backend progressing.",
};
export const referenceNavigation = [
  ["browser-package", "Browser package"], ["python-host", "Python setup"],
  ["python-tensors", "Python tensors"], ["webgpu-runtime", "JavaScript WebGPU"],
  ["tensor-view", "Tensor views"],
  ["tensor-copy", "Tensor copy"], ["tensor-sum", "Sum"],
  ["tensor-multiplication", "Multiplication"], ["tensor-matmul", "Matrix products"],
  ["functional-gradients", "Functional gradients"], ["backward-gradients", "Backward and .grad"],
  ["gradient-recording", "Gradient scopes"], ["sgd", "SGD"],
];
export const references = referenceNavigation.map(([name]) => name);

/** @param {string} source Repository-relative admitted document. @returns {string} */
export function documentRoute(source) {
  if (!source.startsWith("docs/") || !source.endsWith(".md") || source.includes("..")) {
    throw new Error(`Invalid document source: ${source}`);
  }
  return "/" + source.replace(/(?:\/readme)?\.md$/i, "").toLowerCase() + "/";
}
