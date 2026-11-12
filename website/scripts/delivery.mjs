import { createHash } from "node:crypto";
import { extname } from "node:path";
import { parse } from "parse5";

/** @param {object} node @param {string[]} hashes @returns {void} */
function inlineScripts(node, hashes) {
  if (node.tagName === "script" && !node.attrs.some((attribute) => attribute.name === "src")) {
    const type = node.attrs.find((attribute) => attribute.name === "type")?.value;
    if (!type || ["module", "text/javascript", "application/javascript"].includes(type)) {
      const source = node.childNodes.map((child) => child.value ?? "").join("");
      hashes.push(`'sha256-${createHash("sha256").update(source).digest("base64")}'`);
    }
  }
  for (const child of node.childNodes ?? []) inlineScripts(child, hashes);
}

/** @param {string} html @returns {string[]} */
export function scriptHashes(html) {
  const hashes = [];
  inlineScripts(parse(html), hashes);
  return [...new Set(hashes)];
}

/** @param {string} path @param {string} html @returns {Record<string,string>} */
export function deliveryHeaders(path, html = "") {
  const worker = /^\/playground\/executor-[a-f0-9]{64}\.worker\.js$/.test(path);
  const scripts = worker ? "'self' 'unsafe-eval' 'wasm-unsafe-eval'" : ["'self'", "'wasm-unsafe-eval'", ...(html ? scriptHashes(html) : [])].join(" ");
  const immutable = /^\/(?:vendor\/[^/]+\/[^/]+\/|diagrams\/[a-f0-9]{64}\.svg$|_astro\/)/.test(path) || worker;
  const executionPage = ["/", "/index.html", "/playground/", "/playground/index.html"].includes(path);
  const gpuWorker = /^\/vendor\/tabgrad\/[^/]+\/webgpu-worker\.js$/.test(path);
  const searchWorker = path === "/pagefind/pagefind-worker.js";
  return {
    ...(executionPage ? { "Cross-Origin-Opener-Policy": "same-origin" } : {}),
    ...(executionPage || worker || gpuWorker || searchWorker ? { "Cross-Origin-Embedder-Policy": "require-corp" } : {}),
    "Content-Security-Policy": `default-src 'self'; script-src ${scripts}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'`,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  };
}

/** @param {string} path @returns {string} */
export function contentType(path) {
  return ({ ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png", ".xml": "application/xml; charset=utf-8", ".zip": "application/zip", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8", ".py": "text/plain; charset=utf-8", ".woff2": "font/woff2" })[extname(path)] ?? (/LICENSE$/.test(path) ? "text/plain; charset=utf-8" : "application/octet-stream");
}
