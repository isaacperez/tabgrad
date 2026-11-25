import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, isAbsolute, join, relative, sep } from "node:path";

import { fixtureModule } from "./runtime-wasm-fixture.mjs";
import { CPU_ABI_VERSION, CPU_CAPABILITIES } from "../../dist/backends/cpu/kernel-catalogue.js";
import { CPU_MEMORY_PROFILE } from "../../dist/backends/cpu/memory-capacity.js";

/**
 * One loopback server for built-distribution and virtual raw-ABI fixtures.
 * Tests own start/close and may gate virtual responses or inspect request counts.
 * Importing this support never registers or runs a test suite.
 */
export class RuntimeFixtureServer {
  requestCounts = new Map();
  virtualResponses = new Map();

  constructor(distributionRoot) {
    this.distributionRoot = distributionRoot;
  }

  async start() {
    const server = createServer(this.handleRequest.bind(this));
    this.server = server;
    let onListening;
    let onError;
    try {
      await new Promise((resolve, reject) => {
        onListening = resolve;
        onError = reject;
        server.once("listening", onListening);
        server.once("error", onError);
        server.listen(0, "127.0.0.1");
      });
    } finally {
      server.off("listening", onListening);
      server.off("error", onError);
    }
    const address = server.address();
    this.distributionUrl = `http://127.0.0.1:${address.port}/`;
    return this.distributionUrl;
  }

  async close() {
    if (this.server === undefined) return;
    await new Promise((resolve, reject) => {
      this.server.close((error) => {
        if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
        else resolve();
      });
    });
  }

  installFixture(name, moduleOptions = {}, manifestTransform = (value) => value) {
    const modulePath = `/fixture-${name}.wasm`;
    const manifestPath = `/fixture-${name}.json`;
    const bytes = fixtureModule(moduleOptions);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const variant = (id, requiredFeatures) => ({
      id,
      path: modulePath.slice(1),
      sha256: hash,
      byteLength: bytes.byteLength,
      requiredFeatures,
    });
    const manifest = manifestTransform({
      schemaVersion: 1,
      moduleVersion: CPU_MEMORY_PROFILE.moduleVersion,
      abiVersion: CPU_ABI_VERSION,
      addressWidth: 32,
      sharedMemory: false,
      capabilities: [...CPU_CAPABILITIES],
      imports: [{ module: "env", name: "memory", kind: "memory" }],
      memory: { initialPages: CPU_MEMORY_PROFILE.initialPages, maximumPages: CPU_MEMORY_PROFILE.maximumPages,
        alignment: CPU_MEMORY_PROFILE.alignment },
      variants: [variant("scalar", []), variant("simd128", ["simd128"])],
    });
    this.virtualResponses.set(modulePath, {
      body: bytes,
      contentType: "application/wasm",
    });
    this.virtualResponses.set(manifestPath, {
      body: Buffer.from(`${JSON.stringify(manifest)}\n`),
      contentType: "application/json",
    });
    return new URL(manifestPath.slice(1), this.distributionUrl);
  }

  async handleRequest(request, response) {
    try {
      const pathname = new URL(request.url, "http://localhost").pathname;
      this.requestCounts.set(pathname, (this.requestCounts.get(pathname) ?? 0) + 1);
      const virtualResponse = this.virtualResponses.get(pathname);
      if (virtualResponse !== undefined) {
        if (virtualResponse.waitFor !== undefined) {
          await virtualResponse.waitFor;
        }
        response.writeHead(200, { "content-type": virtualResponse.contentType })
          .end(virtualResponse.body);
        return;
      }
      const path = join(this.distributionRoot, pathname);
      const pathFromRoot = relative(this.distributionRoot, path);
      if (
        pathFromRoot === ".."
        || pathFromRoot.startsWith(`..${sep}`)
        || isAbsolute(pathFromRoot)
      ) {
        response.writeHead(403).end();
        return;
      }
      const body = await readFile(path);
      const contentType = extname(path) === ".wasm"
        ? "application/wasm"
        : extname(path) === ".json"
          ? "application/json"
          : "text/javascript";
      response.writeHead(200, { "content-type": contentType }).end(body);
    } catch {
      response.writeHead(404).end();
    }
  }
}
