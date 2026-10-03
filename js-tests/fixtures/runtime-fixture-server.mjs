import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, isAbsolute, join, relative, sep } from "node:path";

import { fixtureModule } from "./runtime-wasm-fixture.mjs";

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
    this.server = createServer(this.handleRequest.bind(this));
    await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    this.distributionUrl = `http://127.0.0.1:${address.port}/`;
    return this.distributionUrl;
  }

  async close() {
    await new Promise((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
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
      moduleVersion: 4,
      abiVersion: 1,
      addressWidth: 32,
      sharedMemory: false,
      capabilities: ["add-f32", "sum-f32", "mul-f32", "expand-f32"],
      imports: [{ module: "env", name: "memory", kind: "memory" }],
      memory: { initialPages: 32, maximumPages: 1024, alignment: 16 },
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
