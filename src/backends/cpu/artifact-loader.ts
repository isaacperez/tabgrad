import { TabgradError } from "../../shared/errors.js";
import type { BackendDiagnostics, WasmVariant } from "./cpu-types.js";
import { CPU_MEMORY_PROFILE, DEFAULT_CPU_LINEAR_MEMORY_BYTES, WEBASSEMBLY_PAGE_BYTES,
  validateCpuLinearMemoryBytes, type CpuMemoryCapacity } from "./memory-capacity.js";

import { assertCpuArtifactAbi } from "./artifact-abi.js";
import { CPU_ABI_VERSION, CPU_CAPABILITIES, type KernelExports } from "./kernel-catalogue.js";

type BackendPreparationPhase =
  | "manifest-fetch"
  | "manifest-parse"
  | "manifest-validation"
  | "capability-selection"
  | "module-fetch"
  | "integrity-validation"
  | "compilation"
  | "instantiation"
  | "abi-validation";

interface ManifestVariant {
  readonly id: WasmVariant;
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly requiredFeatures: readonly string[];
}

interface WasmManifest {
  readonly schemaVersion: number;
  readonly moduleVersion: number;
  readonly abiVersion: number;
  readonly addressWidth: number;
  readonly sharedMemory: boolean;
  readonly capabilities: readonly string[];
  readonly imports: readonly [{
    readonly module: "env";
    readonly name: "memory";
    readonly kind: "memory";
  }];
  readonly memory: {
    readonly initialPages: number;
    readonly maximumPages: number;
    readonly alignment: number;
  };
  readonly variants: readonly ManifestVariant[];
}

interface PreparedCpuArtifact {
  readonly memory: WebAssembly.Memory;
  readonly exports: KernelExports;
  readonly arenaBase: number;
  readonly capacity: CpuMemoryCapacity;
  readonly alignment: number;
  readonly variant: WasmVariant;
}

type PreparationTimings = {
  -readonly [Key in keyof BackendDiagnostics["timings"]]: BackendDiagnostics["timings"][Key];
};

const SIMD_PROBE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
  0x03, 0x02, 0x01, 0x00,
  0x0a, 0x08, 0x01, 0x06, 0x00, 0x41, 0x00, 0xfd, 0x0f, 0x0b,
]);

/**
 * Verify and instantiate one CPU artifact. Preparation caching, generation and
 * invocation ownership stay with the backend that consumes this physical result.
 */
export class CpuArtifactLoader {
  readonly #manifestUrl: URL;
  readonly #forceVariant: WasmVariant | undefined;
  readonly #timings: PreparationTimings;
  readonly #linearMemoryBytes: number;

  constructor(
    manifestUrl: URL,
    forceVariant: WasmVariant | undefined,
    timings: PreparationTimings,
    linearMemoryBytes = DEFAULT_CPU_LINEAR_MEMORY_BYTES,
  ) {
    this.#manifestUrl = manifestUrl;
    this.#forceVariant = forceVariant;
    this.#timings = timings;
    this.#linearMemoryBytes = validateCpuLinearMemoryBytes(linearMemoryBytes);
  }

  async load(): Promise<PreparedCpuArtifact> {
    let phase: BackendPreparationPhase = "manifest-fetch";
    try {
      const manifest = await this.#loadManifest();
      phase = "capability-selection";
      const supportsSimd = WebAssembly.validate(SIMD_PROBE);
      const selectedVariant = this.#forceVariant
        ?? (supportsSimd ? "simd128" : "scalar");
      const variant = manifest.variants.find((candidate) => candidate.id === selectedVariant);
      if (variant === undefined) {
        throw new TabgradError(
          "BACKEND_CAPABILITY_MISMATCH",
          "The manifest does not contain the selected WebAssembly variant.",
          { selectedVariant },
        );
      }
      if (selectedVariant === "simd128" && !supportsSimd) {
        throw new TabgradError(
          "BACKEND_CAPABILITY_MISMATCH",
          "The selected WebAssembly SIMD variant is not supported.",
        );
      }
      const moduleUrl = new URL(variant.path, this.#manifestUrl);
      phase = "module-fetch";
      const moduleFetchStart = performance.now();
      const response = await fetch(moduleUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} while fetching ${moduleUrl.href}`);
      }
      const bytes = await response.arrayBuffer();
      this.#timings.moduleFetchMilliseconds = performance.now() - moduleFetchStart;
      if (bytes.byteLength !== variant.byteLength) {
        throw new TabgradError(
          "BACKEND_HASH_MISMATCH",
          "The WebAssembly module length does not match its manifest.",
          {
            actualByteLength: bytes.byteLength,
            backend: "webassembly-cpu",
            expectedByteLength: variant.byteLength,
            phase: "integrity-validation",
          },
        );
      }
      phase = "integrity-validation";
      const integrityCheckStart = performance.now();
      const hash = await this.#sha256(bytes);
      this.#timings.integrityCheckMilliseconds = performance.now() - integrityCheckStart;
      if (hash !== variant.sha256) {
        throw new TabgradError(
          "BACKEND_HASH_MISMATCH",
          "The WebAssembly module hash does not match its manifest.",
          {
            actualSha256: hash,
            backend: "webassembly-cpu",
            expectedSha256: variant.sha256,
            phase,
          },
        );
      }
      phase = "compilation";
      const compilationStart = performance.now();
      const module = await WebAssembly.compile(bytes);
      this.#timings.compilationMilliseconds = performance.now() - compilationStart;
      phase = "abi-validation";
      const imports = WebAssembly.Module.imports(module);
      if (
        imports.length !== 1
        || imports[0]?.module !== "env"
        || imports[0]?.name !== "memory"
        || imports[0]?.kind !== "memory"
      ) {
        throw new TabgradError(
          "BACKEND_ABI_MISMATCH",
          "The WebAssembly module imports do not match the raw ABI.",
          { backend: "webassembly-cpu", imports, phase },
        );
      }
      phase = "instantiation";
      const memory = new WebAssembly.Memory({
        initial: manifest.memory.initialPages,
        maximum: this.#linearMemoryBytes / WEBASSEMBLY_PAGE_BYTES,
      });
      const instantiationStart = performance.now();
      const instance = await WebAssembly.instantiate(module, { env: { memory } });
      this.#timings.instantiationMilliseconds = performance.now() - instantiationStart;
      phase = "abi-validation";
      const exports = instance.exports;
      assertCpuArtifactAbi(exports);
      const arenaBase = exports.tabgrad_arena_base() >>> 0;
      if (
        arenaBase > memory.buffer.byteLength
        || arenaBase % manifest.memory.alignment !== 0
      ) {
        throw new TabgradError(
          "BACKEND_ABI_MISMATCH",
          "The WebAssembly module returned an invalid arena boundary.",
          { arenaBase, backend: "webassembly-cpu", phase },
        );
      }
      return {
        memory,
        exports,
        arenaBase,
        capacity: Object.freeze({
          artifactMaximumBytes: manifest.memory.maximumPages * WEBASSEMBLY_PAGE_BYTES,
          linearMemoryLimitBytes: this.#linearMemoryBytes,
          arenaBaseBytes: arenaBase,
          arenaCapacityBytes: this.#linearMemoryBytes - arenaBase,
        }),
        alignment: manifest.memory.alignment,
        variant: selectedVariant,
      };
    } catch (error) {
      throw this.asLoadError(error, phase);
    }
  }

  async #loadManifest(): Promise<WasmManifest> {
    const start = performance.now();
    let response: Response;
    try {
      response = await fetch(this.#manifestUrl);
      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status} while fetching ${this.#manifestUrl.href}`,
        );
      }
    } catch (error) {
      throw new TabgradError(
        "BACKEND_LOAD_FAILED",
        "The WebAssembly manifest could not be fetched.",
        {
          backend: "webassembly-cpu",
          manifestUrl: this.#manifestUrl.href,
          phase: "manifest-fetch",
        },
        error,
      );
    }
    let candidate: unknown;
    try {
      candidate = await response.json();
    } catch (error) {
      throw new TabgradError(
        "BACKEND_LOAD_FAILED",
        "The WebAssembly manifest could not be parsed.",
        {
          backend: "webassembly-cpu",
          manifestUrl: this.#manifestUrl.href,
          phase: "manifest-parse",
        },
        error,
      );
    }
    this.#timings.manifestFetchMilliseconds = performance.now() - start;
    if (!this.#isManifest(candidate)) {
      throw new TabgradError(
        "BACKEND_MANIFEST_INVALID",
        "The WebAssembly manifest does not match the supported schema.",
        {
          backend: "webassembly-cpu",
          manifestUrl: this.#manifestUrl.href,
          phase: "manifest-validation",
        },
      );
    }
    return candidate;
  }

  asLoadError(error: unknown, fallbackPhase: BackendPreparationPhase): TabgradError {
    if (error instanceof TabgradError) {
      const recordedPhase = error.details.phase;
      return new TabgradError(
        error.code,
        error.message,
        {
          ...error.details,
          backend: "webassembly-cpu",
          phase: typeof recordedPhase === "string"
            ? recordedPhase
            : fallbackPhase,
        },
        error.cause,
      );
    }
    return new TabgradError(
      "BACKEND_LOAD_FAILED",
      "The WebAssembly CPU backend could not be initialized.",
      {
        backend: "webassembly-cpu",
        manifestUrl: this.#manifestUrl.href,
        phase: fallbackPhase,
      },
      error,
    );
  }

  #isManifest(candidate: unknown): candidate is WasmManifest {
    if (typeof candidate !== "object" || candidate === null) {
      return false;
    }
    const value = candidate as Record<string, unknown>;
    const memory = value.memory as Record<string, unknown> | undefined;
    const variants = value.variants;
    const capabilities = value.capabilities;
    return value.schemaVersion === 1
      && value.moduleVersion === CPU_MEMORY_PROFILE.moduleVersion
      && value.abiVersion === CPU_ABI_VERSION
      && value.addressWidth === 32
      && value.sharedMemory === false
      && Array.isArray(capabilities)
      && capabilities.length === CPU_CAPABILITIES.length
      && CPU_CAPABILITIES.every((name, index) => capabilities[index] === name)
      && Array.isArray(value.imports)
      && value.imports.length === 1
      && this.#isMemoryImport(value.imports[0])
      && typeof memory === "object"
      && memory !== null
      && Number.isInteger(memory.initialPages)
      && Number.isInteger(memory.maximumPages)
      && memory.initialPages === CPU_MEMORY_PROFILE.initialPages
      && memory.maximumPages === CPU_MEMORY_PROFILE.maximumPages
      && memory.alignment === CPU_MEMORY_PROFILE.alignment
      && this.#hasManifestVariants(variants);
  }

  #isMemoryImport(candidate: unknown): boolean {
    if (typeof candidate !== "object" || candidate === null) {
      return false;
    }
    const value = candidate as Record<string, unknown>;
    return value.module === "env" && value.name === "memory" && value.kind === "memory";
  }

  #isManifestVariant(candidate: unknown): candidate is ManifestVariant {
    if (typeof candidate !== "object" || candidate === null) {
      return false;
    }
    const value = candidate as Record<string, unknown>;
    return (value.id === "scalar" || value.id === "simd128")
      && typeof value.path === "string"
      && this.#isRelativeArtifactPath(value.path)
      && typeof value.sha256 === "string"
      && /^[0-9a-f]{64}$/.test(value.sha256)
      && Number.isInteger(value.byteLength)
      && Number(value.byteLength) > 0
      && Array.isArray(value.requiredFeatures)
      && (value.id === "scalar"
        ? value.requiredFeatures.length === 0
        : value.requiredFeatures.length === 1 && value.requiredFeatures[0] === "simd128");
  }

  #hasManifestVariants(candidate: unknown): candidate is readonly [ManifestVariant, ManifestVariant] {
    if (
      !Array.isArray(candidate)
      || candidate.length !== 2
      || !candidate.every((variant) => this.#isManifestVariant(variant))
    ) {
      return false;
    }
    const identifiers = new Set(candidate.map((variant) => variant.id));
    return identifiers.size === 2
      && identifiers.has("scalar")
      && identifiers.has("simd128");
  }

  #isRelativeArtifactPath(path: string): boolean {
    if (
      path.length === 0
      || path.startsWith("/")
      || path.startsWith("\\")
      || path.includes("\\")
      || /^[A-Za-z][A-Za-z\d+.-]*:/.test(path)
      || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      return false;
    }
    const resolved = new URL(path, this.#manifestUrl);
    return resolved.protocol === this.#manifestUrl.protocol
      && resolved.origin === this.#manifestUrl.origin;
  }

  async #sha256(bytes: ArrayBuffer): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

}
