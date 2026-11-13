import { fileURLToPath } from "node:url";
import { readReleaseInput } from "./release-input.mjs";
import { resolve } from "node:path";

export const websiteRoot = fileURLToPath(new URL("..", import.meta.url));
export const repositoryRoot = resolve(websiteRoot, "..");
export const repositoryUrl = "https://github.com/isaacperez/tabgrad";
export const packageUrl = "https://www.npmjs.com/package/@tabgrad/tabgrad";
export const maintainerContact = { label: "@isaperbor", url: "https://x.com/isaperbor", linkedInUrl: "https://www.linkedin.com/in/isaperbor/" };
export const supportUrl = "https://buymeacoffee.com/isaperbor";
export const referenceRuntimeVersion = "0.3.0";
export const releaseInput = readReleaseInput(process.env.TABGRAD_WEBSITE_RELEASE_INPUT);
export const runtimeVersion = releaseInput?.release.version ?? referenceRuntimeVersion;
export const pyodideVersion = "314.0.6";

export const documentDirectories = ["concepts", "architecture", "components", "flows"];
// Editorial summaries for chapters whose opening paragraph records acceptance
// rather than introducing the topic. Other pages use their Markdown introduction.
export const documentDescriptions = {
  "docs/architecture/browser-distribution.md": "How Tabgrad keeps JavaScript, Python, workers and numerical assets together in one versioned browser distribution.",
  "docs/architecture/central-decision.md": "Why Tabgrad shares one semantic runtime across Python and JavaScript, with separate CPU and GPU numerical backends.",
  "docs/architecture/python-observation.md": "How ordinary Python calls wait for GPU results while a separate worker keeps the backend progressing.",
};
export const setupNavigation = [
  ["browser-package", "JavaScript setup"], ["python-host", "Python setup"],
];
export const referenceNavigation = [
  ["python-tensors", "Python tensors"], ["webgpu-runtime", "JavaScript WebGPU"],
  ["tensor-view", "Tensor views"],
  ["tensor-copy", "Tensor copy"], ["tensor-sum", "Sum"],
  ["tensor-multiplication", "Multiplication"], ["tensor-matmul", "Matrix products"],
  ["functional-gradients", "Functional gradients"], ["backward-gradients", "Backward and .grad"],
  ["gradient-recording", "Gradient scopes"], ["sgd", "SGD"],
];
export const references = [...setupNavigation, ...referenceNavigation].map(([name]) => name);

/** @param {string} source Repository-relative admitted document. @returns {string} */
export function documentRoute(source) {
  if (!source.startsWith("docs/") || !source.endsWith(".md") || source.includes("..")) {
    throw new Error(`Invalid document source: ${source}`);
  }
  return "/" + source.replace(/(?:\/readme)?\.md$/i, "").toLowerCase() + "/";
}
