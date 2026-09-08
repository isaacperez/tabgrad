import { TabgradError } from "./errors.js";
import type { ExecutableProgram, ProgramSlot } from "./executable-program.js";

const ABI_VERSION = 1;
const CAPABILITY_ADD_FLOAT32 = 1;
const WEBASSEMBLY_PAGE_BYTES = 65_536;
const MAXIMUM_ADDRESS = 0xffff_ffff;

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

export type WasmVariant = "scalar" | "simd128";

export interface BackendDiagnostics {
  readonly backendLoads: number;
  readonly hostToWasmBytes: number;
  readonly hostToWasmCopies: number;
  readonly wasmToHostBytes: number;
  readonly wasmToHostCopies: number;
  readonly kernelCalls: number;
  readonly liveAllocationBytes: number;
  readonly highWaterAllocationBytes: number;
  readonly reservedAllocationBytes: number;
  readonly highWaterReservedAllocationBytes: number;
  readonly wasmMemoryBytes: number;
  readonly selectedVariant: WasmVariant | null;
  readonly timings: Readonly<{
    readonly manifestFetchMilliseconds: number;
    readonly moduleFetchMilliseconds: number;
    readonly integrityCheckMilliseconds: number;
    readonly compilationMilliseconds: number;
    readonly instantiationMilliseconds: number;
  }>;
}

export interface ResidentAllocation {
  readonly generation: number;
  readonly offset: number;
  readonly byteLength: number;
  readonly reservedByteLength: number;
  released: boolean;
}

export interface ProgramBinding {
  readonly hostData?: Float32Array;
  readonly resident?: ResidentAllocation;
}

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

interface KernelExports extends WebAssembly.Exports {
  readonly tabgrad_abi_version: () => number;
  readonly tabgrad_capabilities: () => number;
  readonly tabgrad_arena_base: () => number;
  readonly tabgrad_add_f32: (
    leftOffset: number,
    rightOffset: number,
    outputOffset: number,
    length: number,
  ) => number;
}

interface BackendContext {
  readonly generation: number;
  readonly memory: WebAssembly.Memory;
  readonly exports: KernelExports;
  readonly allocator: LinearMemoryAllocator;
  readonly variant: WasmVariant;
  poisoned: boolean;
}

interface FreeSegment {
  offset: number;
  byteLength: number;
}

class LinearMemoryAllocator {
  readonly #memory: WebAssembly.Memory;
  readonly #maximumPages: number;
  readonly #alignment: number;
  #cursor: number;
  #freeSegments: FreeSegment[] = [];
  #livePayloadBytes = 0;
  #highWaterPayloadBytes = 0;
  #liveReservedBytes = 0;
  #highWaterReservedBytes = 0;
  #generation: number;

  constructor(
    memory: WebAssembly.Memory,
    arenaBase: number,
    maximumPages: number,
    alignment: number,
    generation: number,
  ) {
    this.#memory = memory;
    this.#maximumPages = maximumPages;
    this.#alignment = alignment;
    this.#cursor = this.#align(arenaBase);
    this.#generation = generation;
  }

  get livePayloadBytes(): number {
    return this.#livePayloadBytes;
  }

  get highWaterPayloadBytes(): number {
    return this.#highWaterPayloadBytes;
  }

  get liveReservedBytes(): number {
    return this.#liveReservedBytes;
  }

  get highWaterReservedBytes(): number {
    return this.#highWaterReservedBytes;
  }

  allocate(byteLength: number): ResidentAllocation {
    const reservedByteLength = this.#align(byteLength);
    let offset: number | undefined;
    for (let index = 0; index < this.#freeSegments.length; index += 1) {
      const segment = this.#freeSegments[index];
      if (segment !== undefined && segment.byteLength >= reservedByteLength) {
        offset = segment.offset;
        if (segment.byteLength === reservedByteLength) {
          this.#freeSegments.splice(index, 1);
        } else {
          segment.offset += reservedByteLength;
          segment.byteLength -= reservedByteLength;
        }
        break;
      }
    }

    if (offset === undefined) {
      offset = this.#cursor;
      const end = offset + reservedByteLength;
      if (!Number.isSafeInteger(end) || end > MAXIMUM_ADDRESS) {
        throw new TabgradError(
          "RESOURCE_EXHAUSTED",
          "The WebAssembly allocation exceeds the 32-bit address space.",
          { byteLength },
        );
      }
      this.#ensureMemory(end);
      this.#cursor = end;
    }

    this.#livePayloadBytes += byteLength;
    this.#liveReservedBytes += reservedByteLength;
    this.#highWaterPayloadBytes = Math.max(
      this.#highWaterPayloadBytes,
      this.#livePayloadBytes,
    );
    this.#highWaterReservedBytes = Math.max(
      this.#highWaterReservedBytes,
      this.#liveReservedBytes,
    );
    return {
      generation: this.#generation,
      offset,
      byteLength,
      reservedByteLength,
      released: false,
    };
  }

  release(allocation: ResidentAllocation): void {
    if (allocation.released) {
      return;
    }
    if (allocation.generation !== this.#generation) {
      throw new TabgradError(
        "BACKEND_STATUS_ERROR",
        "A WebAssembly allocation belongs to another backend generation.",
      );
    }
    allocation.released = true;
    this.#livePayloadBytes -= allocation.byteLength;
    this.#liveReservedBytes -= allocation.reservedByteLength;
    if (allocation.reservedByteLength > 0) {
      this.#freeSegments.push({
        offset: allocation.offset,
        byteLength: allocation.reservedByteLength,
      });
      this.#coalesceFreeSegments();
    }
  }

  #align(value: number): number {
    return Math.ceil(value / this.#alignment) * this.#alignment;
  }

  #ensureMemory(requiredBytes: number): void {
    if (requiredBytes <= this.#memory.buffer.byteLength) {
      return;
    }
    const requiredPages = Math.ceil(requiredBytes / WEBASSEMBLY_PAGE_BYTES);
    const currentPages = this.#memory.buffer.byteLength / WEBASSEMBLY_PAGE_BYTES;
    if (requiredPages > this.#maximumPages) {
      throw new TabgradError(
        "RESOURCE_EXHAUSTED",
        "The WebAssembly memory limit cannot satisfy this allocation.",
        { maximumPages: this.#maximumPages, requiredPages },
      );
    }
    try {
      this.#memory.grow(requiredPages - currentPages);
    } catch (error) {
      throw new TabgradError(
        "RESOURCE_EXHAUSTED",
        "The browser could not grow WebAssembly memory for this allocation.",
        { requiredPages },
        error,
      );
    }
  }

  #coalesceFreeSegments(): void {
    this.#freeSegments.sort((left, right) => left.offset - right.offset);
    const merged: FreeSegment[] = [];
    for (const segment of this.#freeSegments) {
      const previous = merged.at(-1);
      if (previous !== undefined && previous.offset + previous.byteLength === segment.offset) {
        previous.byteLength += segment.byteLength;
      } else {
        merged.push({ ...segment });
      }
    }
    this.#freeSegments = merged;
  }
}

const SIMD_PROBE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
  0x03, 0x02, 0x01, 0x00,
  0x0a, 0x08, 0x01, 0x06, 0x00, 0x41, 0x00, 0xfd, 0x0f, 0x0b,
]);

export class WebAssemblyCpuBackend {
  readonly #manifestUrl: URL;
  readonly #forceVariant: WasmVariant | undefined;
  #contextPromise: Promise<BackendContext> | undefined;
  #context: BackendContext | undefined;
  #generation = 0;
  #closed = false;
  #backendLoads = 0;
  #hostToWasmBytes = 0;
  #hostToWasmCopies = 0;
  #wasmToHostBytes = 0;
  #wasmToHostCopies = 0;
  #kernelCalls = 0;
  #selectedVariant: WasmVariant | null = null;
  readonly #timings = {
    manifestFetchMilliseconds: 0,
    moduleFetchMilliseconds: 0,
    integrityCheckMilliseconds: 0,
    compilationMilliseconds: 0,
    instantiationMilliseconds: 0,
  };

  constructor(manifestUrl: URL, forceVariant?: WasmVariant) {
    this.#manifestUrl = manifestUrl;
    this.#forceVariant = forceVariant;
  }

  diagnostics(): BackendDiagnostics {
    return Object.freeze({
      backendLoads: this.#backendLoads,
      hostToWasmBytes: this.#hostToWasmBytes,
      hostToWasmCopies: this.#hostToWasmCopies,
      wasmToHostBytes: this.#wasmToHostBytes,
      wasmToHostCopies: this.#wasmToHostCopies,
      kernelCalls: this.#kernelCalls,
      liveAllocationBytes: this.#context?.allocator.livePayloadBytes ?? 0,
      highWaterAllocationBytes: this.#context?.allocator.highWaterPayloadBytes ?? 0,
      reservedAllocationBytes: this.#context?.allocator.liveReservedBytes ?? 0,
      highWaterReservedAllocationBytes:
        this.#context?.allocator.highWaterReservedBytes ?? 0,
      wasmMemoryBytes: this.#context?.memory.buffer.byteLength ?? 0,
      selectedVariant: this.#selectedVariant,
      timings: Object.freeze({ ...this.#timings }),
    });
  }

  async execute(
    program: ExecutableProgram,
    bindings: ReadonlyMap<ProgramSlot, ProgramBinding>,
  ): Promise<ReadonlyMap<ProgramSlot, ResidentAllocation>> {
    this.#assertOpen();
    const context = await this.#getContext();
    if (context.poisoned) {
      throw new TabgradError(
        "BACKEND_TRAP",
        "The WebAssembly backend context is quarantined after a trap.",
        { backend: "webassembly-cpu", phase: "execution" },
      );
    }

    const allocations = new Map<ProgramSlot, ResidentAllocation>();
    const newlyAllocated: ResidentAllocation[] = [];
    try {
      for (const value of program.values) {
        const binding = bindings.get(value.slot);
        if (binding?.resident !== undefined) {
          this.#validateAllocation(context, binding.resident);
          allocations.set(value.slot, binding.resident);
          continue;
        }
        const byteLength = value.shape[0] * Float32Array.BYTES_PER_ELEMENT;
        const allocation = context.allocator.allocate(byteLength);
        newlyAllocated.push(allocation);
        allocations.set(value.slot, allocation);
        if (binding?.hostData !== undefined) {
          this.#floatView(context.memory, allocation, value.shape[0]).set(binding.hostData);
          this.#hostToWasmBytes += byteLength;
          this.#hostToWasmCopies += 1;
        } else if (value.source === "binding") {
          throw new TabgradError(
            "BACKEND_STATUS_ERROR",
            "An executable input has no host or resident binding.",
            { backend: "webassembly-cpu", phase: "execution", slot: value.slot },
          );
        }
      }

      for (const computation of program.computations) {
        const left = this.#requiredAllocation(allocations, computation.left);
        const right = this.#requiredAllocation(allocations, computation.right);
        const output = this.#requiredAllocation(allocations, computation.output);
        const length = program.values[computation.output]?.shape[0];
        if (length === undefined) {
          throw new TabgradError(
            "BACKEND_STATUS_ERROR",
            "An executable computation references a missing output value.",
            {
              backend: "webassembly-cpu",
              phase: "execution",
              programValueSlot: computation.output,
              slot: computation.output,
            },
          );
        }
        let status: number;
        try {
          this.#kernelCalls += 1;
          status = context.exports.tabgrad_add_f32(
            left.offset,
            right.offset,
            output.offset,
            length,
          );
        } catch (error) {
          context.poisoned = true;
          throw new TabgradError(
            "BACKEND_TRAP",
            "The WebAssembly addition kernel trapped.",
            {
              backend: "webassembly-cpu",
              phase: "execution",
              operation: "add-f32",
              programValueSlot: computation.output,
            },
            error,
          );
        }
        if (status !== 0) {
          throw new TabgradError(
            "BACKEND_STATUS_ERROR",
            "The WebAssembly addition kernel rejected its call.",
            {
              backend: "webassembly-cpu",
              phase: "execution",
              operation: "add-f32",
              programValueSlot: computation.output,
              status,
            },
          );
        }
      }
      return allocations;
    } catch (error) {
      for (const allocation of newlyAllocated) {
        context.allocator.release(allocation);
      }
      throw error;
    }
  }

  read(allocation: ResidentAllocation, length: number): Float32Array {
    const context = this.#requiredContext();
    this.#validateAllocation(context, allocation);
    const result = this.#floatView(context.memory, allocation, length).slice();
    this.#wasmToHostBytes += result.byteLength;
    this.#wasmToHostCopies += 1;
    return result;
  }

  release(allocation: ResidentAllocation): void {
    const context = this.#context;
    if (context === undefined || allocation.released) {
      return;
    }
    this.#validateAllocation(context, allocation);
    context.allocator.release(allocation);
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#context = undefined;
    this.#contextPromise = undefined;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new TabgradError("CLOSED_SESSION", "The runtime session is closed.");
    }
  }

  async #getContext(): Promise<BackendContext> {
    this.#contextPromise ??= this.#loadContext();
    return this.#contextPromise;
  }

  #requiredContext(): BackendContext {
    this.#assertOpen();
    if (this.#context === undefined) {
      throw new TabgradError(
        "BACKEND_STATUS_ERROR",
        "The WebAssembly backend has not been initialized.",
      );
    }
    return this.#context;
  }

  async #loadContext(): Promise<BackendContext> {
    this.#backendLoads += 1;
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
      if ((exports.tabgrad_capabilities() & CAPABILITY_ADD_FLOAT32) === 0) {
        throw new TabgradError(
          "BACKEND_CAPABILITY_MISMATCH",
          "The WebAssembly module does not provide float32 addition.",
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
      const context: BackendContext = {
        generation: ++this.#generation,
        memory,
        exports,
        allocator: new LinearMemoryAllocator(
          memory,
          arenaBase,
          manifest.memory.maximumPages,
          manifest.memory.alignment,
          this.#generation,
        ),
        variant: selectedVariant,
        poisoned: false,
      };
      this.#context = context;
      this.#selectedVariant = selectedVariant;
      return context;
    } catch (error) {
      throw this.#asLoadError(error, phase);
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

  #asLoadError(error: unknown, fallbackPhase: BackendPreparationPhase): TabgradError {
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
      && value.moduleVersion === 1
      && value.abiVersion === ABI_VERSION
      && value.addressWidth === 32
      && value.sharedMemory === false
      && Array.isArray(value.capabilities)
      && value.capabilities.length === 1
      && value.capabilities[0] === "add-f32"
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

  #floatView(
    memory: WebAssembly.Memory,
    allocation: ResidentAllocation,
    length: number,
  ): Float32Array {
    return new Float32Array(memory.buffer, allocation.offset, length);
  }

  #validateAllocation(context: BackendContext, allocation: ResidentAllocation): void {
    if (allocation.released || allocation.generation !== context.generation) {
      throw new TabgradError(
        "BACKEND_STATUS_ERROR",
        "A stale or released WebAssembly allocation was used.",
      );
    }
  }

  #requiredAllocation(
    allocations: ReadonlyMap<ProgramSlot, ResidentAllocation>,
    slot: ProgramSlot,
  ): ResidentAllocation {
    const allocation = allocations.get(slot);
    if (allocation === undefined) {
      throw new TabgradError(
        "BACKEND_STATUS_ERROR",
        "An executable computation references an unbound value.",
        { slot },
      );
    }
    return allocation;
  }
}
