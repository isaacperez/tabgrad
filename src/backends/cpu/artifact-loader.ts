import { TabgradError } from "../../shared/errors.js";
import type { BackendDiagnostics, WasmVariant } from "./cpu-types.js";

const ABI_VERSION = 1;
const CAPABILITY_ADD_FLOAT32 = 1;
const CAPABILITY_SUM_FLOAT32 = 2;
const CAPABILITY_MUL_FLOAT32 = 4;
const CAPABILITY_EXPAND_FLOAT32 = 8;
const CAPABILITY_ADD_ALPHA_FLOAT32 = 16;
const REQUIRED_CAPABILITIES = CAPABILITY_ADD_FLOAT32 | CAPABILITY_SUM_FLOAT32 | CAPABILITY_MUL_FLOAT32 | CAPABILITY_EXPAND_FLOAT32 | CAPABILITY_ADD_ALPHA_FLOAT32;

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

export interface KernelExports extends WebAssembly.Exports {
  readonly tabgrad_abi_version: () => number;
  readonly tabgrad_capabilities: () => number;
  readonly tabgrad_arena_base: () => number;
  readonly tabgrad_add_f32: (
    leftOffset: number,
    rightOffset: number,
    outputOffset: number,
    length: number,
  ) => number;
  readonly tabgrad_sum_f32: (inputOffset: number, outputOffset: number, length: number) => number;
  readonly tabgrad_expand_f32: (inputOffset: number, outputOffset: number, length: number) => number;
  readonly tabgrad_mul_f32: (leftOffset: number, rightOffset: number, outputOffset: number, length: number) => number;
  readonly tabgrad_add_alpha_f32: (leftOffset: number, rightOffset: number, outputOffset: number, length: number, alphaBits: number) => number;
}

interface PreparedCpuArtifact {
  readonly memory: WebAssembly.Memory;
  readonly exports: KernelExports;
  readonly arenaBase: number;
  readonly maximumPages: number;
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

  constructor(
    manifestUrl: URL,
    forceVariant: WasmVariant | undefined,
    timings: PreparationTimings,
  ) {
    this.#manifestUrl = manifestUrl;
    this.#forceVariant = forceVariant;
    this.#timings = timings;
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
        maximum: manifest.memory.maximumPages,
      });
      const instantiationStart = performance.now();
      const instance = await WebAssembly.instantiate(module, { env: { memory } });
      this.#timings.instantiationMilliseconds = performance.now() - instantiationStart;
      phase = "abi-validation";
      const exports = instance.exports as KernelExports;
      this.#validateExports(exports);
      if (exports.tabgrad_abi_version() !== ABI_VERSION) {
        throw new TabgradError(
          "BACKEND_ABI_MISMATCH",
          "The WebAssembly module ABI version is incompatible.",
          {
            actual: exports.tabgrad_abi_version(),
            backend: "webassembly-cpu",
            expected: ABI_VERSION,
            phase,
          },
        );
      }
      if ((exports.tabgrad_capabilities() & REQUIRED_CAPABILITIES) !== REQUIRED_CAPABILITIES) {
        throw new TabgradError(
          "BACKEND_CAPABILITY_MISMATCH",
          "The WebAssembly module does not provide the required numerical capabilities.",
          { backend: "webassembly-cpu", phase },
        );
      }
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
        maximumPages: manifest.memory.maximumPages,
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
    return value.schemaVersion === 1
      && value.moduleVersion === 5
      && value.abiVersion === ABI_VERSION
      && value.addressWidth === 32
      && value.sharedMemory === false
      && Array.isArray(value.capabilities)
      && value.capabilities.length === 5
      && value.capabilities[0] === "add-f32"
      && value.capabilities[1] === "sum-f32"
      && value.capabilities[2] === "mul-f32"
      && value.capabilities[3] === "expand-f32"
      && value.capabilities[4] === "add-alpha-f32"
      && Array.isArray(value.imports)
      && value.imports.length === 1
      && this.#isMemoryImport(value.imports[0])
      && typeof memory === "object"
      && memory !== null
      && Number.isInteger(memory.initialPages)
      && Number.isInteger(memory.maximumPages)
      && memory.initialPages === 32
      && memory.maximumPages === 1024
      && memory.alignment === 16
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

  #validateExports(exports: WebAssembly.Exports): asserts exports is KernelExports {
    for (const name of [
      "tabgrad_abi_version",
      "tabgrad_capabilities",
      "tabgrad_arena_base",
      "tabgrad_add_f32",
      "tabgrad_sum_f32",
      "tabgrad_mul_f32",
      "tabgrad_expand_f32",
      "tabgrad_add_alpha_f32",
    ]) {
      if (typeof exports[name] !== "function") {
        throw new TabgradError(
          "BACKEND_ABI_MISMATCH",
          "The WebAssembly module is missing a required function export.",
          { exportName: name },
        );
      }
    }
  }

  async #sha256(bytes: ArrayBuffer): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

}
