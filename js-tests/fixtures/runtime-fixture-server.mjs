import { createHash } from "node:crypto";
import { DistributionFixtureServer } from "./distribution-fixture-server.mjs";
import { fixtureModule } from "./runtime-wasm-fixture.mjs";
import { CPU_ABI_VERSION, CPU_CAPABILITIES, CPU_MODULE_VERSION } from "../../dist/backends/cpu/kernel-catalogue.js";
import { CPU_MEMORY_PROFILE } from "../../dist/backends/cpu/memory-capacity.js";

/** Create synthetic CPU artifacts from the compiled catalogue for runtime tests. */
export class RuntimeFixtureServer extends DistributionFixtureServer {
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
      moduleVersion: CPU_MODULE_VERSION,
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
}
