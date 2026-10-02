import {
  type WasmVariant,
  WebAssemblyCpuBackend,
} from "./cpu-backend.js";
import {
  TabgradError,
  retainExecutionFailureContext,
} from "./errors.js";
import { ExecutionRequest, type QueuedExecutionRequest } from "./execution-request.js";
import { ExecutionTicket, type ExecutionStep } from "./execution-ticket.js";
import { acquireWebGpuDevice, assertWebGpuSetupActive } from "./webgpu-device.js";
import type { ExecutionBackend, ResidentAllocation, TensorDevice } from "./backend.js";
import { WebGpuBackend, type WebGpuDiagnostics, type WebGpuExecutionBackend } from "./webgpu-backend.js";
export type { TensorDevice } from "./backend.js";
import { DerivativeHistory, type DerivativeNode, type DerivativeRecipe } from "./derivative-history.js";
import { IDENTITY_DERIVATIVE, MUL_DERIVATIVE, SUM_DERIVATIVE } from "./derivative-recipes.js";
import { copyTensorShape, equalTensorShapes, inferViewShape, tensorElementCount } from "./tensor-shape.js";
import {
  ExecutableProgram,
  type ProgramProvenance,
} from "./executable-program.js";
import {
  formExecutableProgram,
  type FormedProgram,
  type Materialization,
} from "./program-formation.js";

export type TensorDType = "float32";
export type TensorLayout = "contiguous";

export interface TensorOptions {
  readonly dtype?: TensorDType;
  readonly device?: TensorDevice;
  readonly layout?: TensorLayout;
  readonly shape?: readonly number[];
  readonly requiresGrad?: boolean;
}

export interface RuntimeSessionOptions {
  readonly manifestUrl?: string | URL;
}

export interface WebGpuRuntimeSessionOptions extends RuntimeSessionOptions {
  /** Cancels device acquisition only; close the returned session to end its lifetime. */
  readonly setupAbortSignal?: AbortSignal;
}

export interface RuntimeDiagnostics {
  readonly webgpu: WebGpuDiagnostics | null;
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
  readonly selectedVariant: "scalar" | "simd128" | null;
  readonly timings: Readonly<{
    readonly manifestFetchMilliseconds: number;
    readonly moduleFetchMilliseconds: number;
    readonly integrityCheckMilliseconds: number;
    readonly compilationMilliseconds: number;
    readonly instantiationMilliseconds: number;
  }>;
  readonly liveTensorHandles: number;
  readonly liveTensorValues: number;
  readonly liveOperationRecords: number;
  readonly liveMaterializationRecords: number;
  readonly liveRequestLeases: number;
  readonly liveDerivativeNodes: number;
  readonly liveSavedValues: number;
}

interface TensorMetadata {
  readonly shape: readonly number[];
  readonly dtype: TensorDType;
  readonly device: TensorDevice;
  readonly layout: TensorLayout;
}

interface AdmittedOperation {
  readonly record: OperationRecord;
  readonly outputMetadata: TensorMetadata;
}

interface NumericalOperationDefinition {
  readonly name: "add" | "mul" | "sum" | "expand";
  readonly provenanceSource: "Tensor.add" | "Tensor.mul" | "Tensor.sum" | "DerivativeHistory.sum";
  readonly loweredKind: "add-f32" | "mul-f32" | "sum-f32" | "expand-f32";
  readonly pure: true;
}

function invalidTensorData(cause?: unknown): TabgradError {
  return new TabgradError(
    "INVALID_DATA",
    "Tensor data must be a finite iterable or array-like collection of numbers.",
    { operation: "tensor", contract: "numeric-data" },
    cause,
  );
}

function requireNumericElement(value: unknown): number {
  if (typeof value !== "number") {
    throw invalidTensorData();
  }
  return value;
}

function copyFloat32TensorData(data: unknown): Float32Array {
  try {
    if (typeof data !== "object" || data === null) {
      throw invalidTensorData();
    }
    const source = data as Record<PropertyKey, unknown>;
    const iterator = source[Symbol.iterator];
    if (iterator !== undefined) {
      if (typeof iterator !== "function") {
        throw invalidTensorData();
      }
      return Float32Array.from(
        data as Iterable<number>,
        requireNumericElement,
      );
    }
    const length = source.length;
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
      throw invalidTensorData();
    }
    return Float32Array.from(
      data as ArrayLike<number>,
      requireNumericElement,
    );
  } catch (error) {
    if (error instanceof TabgradError) {
      throw error;
    }
    throw invalidTensorData(error);
  }
}

function retainProgramFailureContext(
  error: unknown,
  program: ExecutableProgram,
  fallbackPhase: string,
): TabgradError {
  const recordedPhase = error instanceof TabgradError
    ? error.details.phase
    : undefined;
  const phase = typeof recordedPhase === "string"
    ? recordedPhase
    : fallbackPhase;
  const tabgradError = error instanceof TabgradError
    ? new TabgradError(
      error.code,
      error.message,
      { ...error.details, backend: program.domain, phase },
      error.cause ?? error,
    )
    : new TabgradError(
      "BACKEND_STATUS_ERROR",
      `The ${program.domain} request failed.`,
      { backend: program.domain, phase: fallbackPhase },
      error,
    );
  const recordedProgramValueSlot = error instanceof TabgradError
    ? error.details.programValueSlot
    : undefined;
  const programValueSlot = typeof recordedProgramValueSlot === "number"
    && Number.isSafeInteger(recordedProgramValueSlot)
    && program.values.some((value) => value.slot === recordedProgramValueSlot)
    ? recordedProgramValueSlot
    : program.result;
  const causalValue = program.values.find(
    (candidate) => candidate.slot === programValueSlot,
  );
  const provenance = causalValue?.provenance ?? Object.freeze({
    operation: "tensor",
    source: "RuntimeSession.tensor",
  });
  return retainExecutionFailureContext(tabgradError, {
    operation: provenance.operation,
    programValueSlot,
    provenance,
    program,
    executionDomain: program.domain,
    backendEndpoints: [program.domain],
    phase,
  });
}

class TensorValue {
  readonly shape: readonly number[];
  readonly dtype: TensorDType;
  readonly device: TensorDevice;
  readonly layout: TensorLayout;
  // Shape and provenance belong to this value; payload and producer ownership
  // are shared by every whole-storage alias.
  readonly storage: StorageState;
  readonly provenance: ProgramProvenance;
  references = 1;

  constructor(metadata: TensorMetadata, producer: OperationRecord | null, storage?: StorageState) {
    this.shape = Object.freeze([...metadata.shape]);
    this.dtype = metadata.dtype;
    this.device = metadata.device;
    this.layout = metadata.layout;
    this.storage = storage ?? new StorageState(this, producer);
    this.provenance = storage !== undefined ? Object.freeze({ operation: "view", source: "Tensor.view" }) : producer?.provenance ?? Object.freeze({
      operation: "tensor",
      source: "RuntimeSession.tensor",
    });
  }

  get storageValue(): TensorValue { return this.storage.value; }
  get producer(): OperationRecord | null { return this.storage.producer; }
}

/** Shared whole-storage lifetime; the origin descriptor preserves producer metadata. */
class StorageState {
  references = 1;
  constructor(readonly value: TensorValue, public producer: OperationRecord | null) {}
}

class OperationRecord {
  readonly definition: NumericalOperationDefinition;
  readonly inputs: readonly TensorValue[];
  readonly provenance: ProgramProvenance;

  constructor(
    definition: NumericalOperationDefinition,
    inputs: readonly TensorValue[],
  ) {
    this.definition = definition;
    this.inputs = Object.freeze([...inputs]);
    this.provenance = Object.freeze({
      operation: definition.name,
      source: definition.provenanceSource,
    });
    Object.freeze(this);
  }
}

class TensorState {
  readonly session: RuntimeSession;
  readonly value: TensorValue;
  closed = false;

  constructor(session: RuntimeSession, value: TensorValue, readonly history: DerivativeNode<TensorValue> | null) {
    this.session = session;
    this.value = value;
  }
}

class MaterializationTable {
  readonly #entries = new Map<StorageState, Materialization>();

  get(value: TensorValue): Materialization | undefined {
    return this.#entries.get(value.storage);
  }

  setHost(value: TensorValue, data: Float32Array): void {
    this.#entries.set(value.storage, { kind: "host", data });
  }

  setResident(
    value: TensorValue,
    allocation: ResidentAllocation,
    backend: ExecutionBackend,
  ): void {
    this.#entries.set(value.storage, { kind: "resident", allocation, backend });
  }

  delete(value: TensorValue): Materialization | undefined {
    const entry = this.#entries.get(value.storage);
    this.#entries.delete(value.storage);
    return entry;
  }

  values(): IterableIterator<Materialization> {
    return this.#entries.values();
  }

  get size(): number {
    return this.#entries.size;
  }

  countResidentProgramReferences(): number {
    let count = 0;
    for (const materialization of this.#entries.values()) {
      if (
        materialization.kind === "resident"
        && Object.hasOwn(materialization, "program")
      ) {
        count += 1;
      }
    }
    return count;
  }

  clear(): void {
    this.#entries.clear();
  }
}

interface RuntimeSessionTestConfiguration {
  readonly forceVariant: WasmVariant;
  readonly onProgramFormed?: (program: ExecutableProgram) => void;
  readonly beforeReadback?: () => void;
}

const RUNTIME_SESSION_TEST_CONFIGURATION = Symbol("RuntimeSessionTestConfiguration");
const RUNTIME_SESSION_GPU_BACKEND = Symbol("RuntimeSessionGpuBackend");

interface InternalRuntimeSessionOptions extends RuntimeSessionOptions {
  readonly [RUNTIME_SESSION_TEST_CONFIGURATION]?: RuntimeSessionTestConfiguration;
  readonly [RUNTIME_SESSION_GPU_BACKEND]?: WebGpuExecutionBackend;
}

interface RuntimeSessionAccess {
  readonly prepare: () => Promise<void>;
  readonly observeSynchronously: (state: TensorState) => Float32Array;
  readonly binary: (definition: EqualShapeBinaryOperationDefinition, left: TensorState, rightHandle: unknown) => Tensor;
  readonly sum: (source: TensorState) => Tensor;
  readonly view: (source: TensorState, shape: unknown) => Tensor;
  readonly observe: (state: TensorState) => Promise<Float32Array>;
  readonly assertOpen: () => void;
  readonly releaseHandle: (state: TensorState) => void;
  readonly countResidentProgramReferences: () => number;
}

const RUNTIME_SESSION_ACCESS = new WeakMap<RuntimeSession, RuntimeSessionAccess>();

function runtimeSessionAccess(session: RuntimeSession): RuntimeSessionAccess {
  const access = RUNTIME_SESSION_ACCESS.get(session);
  if (access === undefined) {
    throw new TabgradError(
      "INVALID_TENSOR",
      "The tensor is not attached to a valid runtime session.",
    );
  }
  return access;
}

let constructTensorHandle: ((state: TensorState) => Tensor) | undefined;
const TENSOR_CONSTRUCTION_TOKEN = Symbol("TensorConstructionToken");
const TENSOR_STATES = new WeakMap<Tensor, TensorState>();

function createTensorHandle(state: TensorState): Tensor {
  if (constructTensorHandle === undefined) {
    throw new Error("Tensor construction is not initialized.");
  }
  return constructTensorHandle(state);
}

function tensorStateFromHandle(handle: unknown): TensorState | null {
  if (
    (typeof handle !== "object" && typeof handle !== "function")
    || handle === null
  ) {
    return null;
  }
  return TENSOR_STATES.get(handle as Tensor) ?? null;
}

function requireTensorState(handle: unknown): TensorState {
  const state = tensorStateFromHandle(handle);
  if (state === null) {
    throw new TabgradError(
      "INVALID_TENSOR",
      "The value is not a valid Tabgrad tensor handle.",
      { operation: "tensor", contract: "tensor-handle" },
    );
  }
  return state;
}

function assertTensorOpen(state: TensorState): void {
  if (state.closed) {
    throw new TabgradError("CLOSED_TENSOR", "The tensor handle is closed.");
  }
  runtimeSessionAccess(state.session).assertOpen();
}

export class Tensor {
  private constructor(state: TensorState, token: symbol) {
    if (token !== TENSOR_CONSTRUCTION_TOKEN) {
      throw new TabgradError(
        "INVALID_TENSOR",
        "Tensor handles can only be created by a runtime session.",
      );
    }
    TENSOR_STATES.set(this, state);
  }

  static {
    constructTensorHandle = (state) => new Tensor(state, TENSOR_CONSTRUCTION_TOKEN);
  }

  get shape(): readonly number[] {
    const state = requireTensorState(this);
    assertTensorOpen(state);
    return state.value.shape;
  }

  get dtype(): TensorDType {
    const state = requireTensorState(this);
    assertTensorOpen(state);
    return state.value.dtype;
  }

  get device(): TensorDevice {
    const state = requireTensorState(this);
    assertTensorOpen(state);
    return state.value.device;
  }

  /** Whether this value participates in first-order functional differentiation. */
  get requiresGrad(): boolean {
    const state = requireTensorState(this);
    assertTensorOpen(state);
    return state.history !== null;
  }

  add(right: Tensor): Tensor {
    const state = requireTensorState(this);
    return runtimeSessionAccess(state.session).binary(ADD_OPERATION, state, right);
  }

  /** Multiply corresponding elements of equal-shape tensors without observing them. */
  mul(right: Tensor): Tensor {
    const state = requireTensorState(this);
    if (arguments.length !== 1) {
      throw new TypeError("Tensor.mul() requires exactly one tensor argument.");
    }
    return runtimeSessionAccess(state.session).binary(MUL_OPERATION, state, right);
  }

  /** Reduce every input element to one rank-zero tensor without observing it. */
  sum(): Tensor {
    const state = requireTensorState(this);
    if (arguments.length !== 0) {
      throw new TypeError("Tensor.sum() accepts no arguments.");
    }
    return runtimeSessionAccess(state.session).sum(state);
  }

  /** Create an independently owned contiguous shape over the same storage. */
  view(shape: readonly number[]): Tensor {
    const state = requireTensorState(this);
    return runtimeSessionAccess(state.session).view(state, shape);
  }

  toArray(): Promise<Float32Array> {
    const state = requireTensorState(this);
    assertTensorOpen(state);
    return runtimeSessionAccess(state.session).observe(state);
  }

  close(): void {
    const state = requireTensorState(this);
    if (!state.closed) {
      state.closed = true;
      runtimeSessionAccess(state.session).releaseHandle(state);
    }
  }
}

class EqualShapeBinaryOperationDefinition implements NumericalOperationDefinition {
  readonly pure = true;

  constructor(
    readonly name: "add" | "mul",
    readonly provenanceSource: "Tensor.add" | "Tensor.mul",
    readonly loweredKind: "add-f32" | "mul-f32",
    readonly description: "addition" | "multiplication",
    readonly derivative: DerivativeRecipe,
  ) {}

  admit(
    session: RuntimeSession,
    left: TensorState,
    rightHandle: unknown,
  ): AdmittedOperation {
    const right = tensorStateFromHandle(rightHandle);
    if (right === null) {
      throw new TabgradError(
        "INVALID_TENSOR",
        `Float32 ${this.description} requires another Tabgrad tensor handle.`,
        { operation: this.name, contract: "tensor-handle" },
      );
    }
    if (left.closed || right.closed) {
      throw new TabgradError(
        "CLOSED_TENSOR",
        `Float32 ${this.description} requires open tensor handles.`,
        {
          operation: this.name,
          contract: "open-input",
          operand: left.closed ? "left" : "right",
        },
      );
    }
    if (left.session !== session || right.session !== session) {
      throw new TabgradError(
        "DIFFERENT_SESSION",
        `Both ${this.description} inputs must belong to the same runtime session.`,
        { operation: this.name, contract: "same-session" },
      );
    }
    if (left.value.dtype !== "float32" || right.value.dtype !== "float32") {
      throw new TabgradError(
        "UNSUPPORTED_DTYPE",
        `Float32 ${this.description} requires float32 inputs.`,
        {
          operation: this.name,
          contract: "float32-inputs",
          leftDType: left.value.dtype,
          rightDType: right.value.dtype,
        },
      );
    }
    if (left.value.device !== right.value.device) {
      throw new TabgradError(
        "UNSUPPORTED_DEVICE",
        `Both ${this.description} inputs must be on the same device.`,
        {
          operation: this.name,
          contract: "same-device",
          device: "webgpu",
          leftDevice: left.value.device,
          rightDevice: right.value.device,
        },
      );
    }
    if (left.value.layout !== "contiguous" || right.value.layout !== "contiguous") {
      throw new TabgradError(
        "UNSUPPORTED_LAYOUT",
        `This ${this.description} definition supports only contiguous inputs.`,
        {
          operation: this.name,
          contract: "contiguous-inputs",
          leftLayout: left.value.layout,
          rightLayout: right.value.layout,
        },
      );
    }
    if (!equalTensorShapes(left.value.shape, right.value.shape)) {
      throw new TabgradError(
        "SHAPE_MISMATCH",
        `Float32 ${this.description} requires equal shapes.`,
        {
          operation: this.name,
          contract: "equal-shape",
          leftShape: left.value.shape,
          rightShape: right.value.shape,
        },
      );
    }

    const inputs = [
      left.value,
      right.value,
    ];
    return Object.freeze({
      record: new OperationRecord(this, inputs),
      outputMetadata: Object.freeze({
        shape: left.value.shape,
        dtype: left.value.dtype,
        device: left.value.device,
        layout: left.value.layout,
      }),
    });
  }
}

const ADD_OPERATION = Object.freeze(new EqualShapeBinaryOperationDefinition(
  "add", "Tensor.add", "add-f32", "addition", IDENTITY_DERIVATIVE,
));
const MUL_OPERATION = Object.freeze(new EqualShapeBinaryOperationDefinition(
  "mul", "Tensor.mul", "mul-f32", "multiplication", MUL_DERIVATIVE,
));

class SumOperationDefinition implements NumericalOperationDefinition {
  readonly derivative = SUM_DERIVATIVE;
  readonly name = "sum";
  readonly provenanceSource = "Tensor.sum";
  readonly loweredKind = "sum-f32";
  readonly pure = true;

  admit(source: TensorState): AdmittedOperation {
    assertTensorOpen(source);
    // Backend support is checked by the session before recording this result.
    return Object.freeze({
      record: new OperationRecord(this, [source.value]),
      outputMetadata: Object.freeze({
        shape: Object.freeze([]), dtype: source.value.dtype,
        device: source.value.device, layout: source.value.layout,
      }),
    });
  }
}

const SUM_OPERATION = Object.freeze(new SumOperationDefinition());

const EXPAND_OPERATION: NumericalOperationDefinition = Object.freeze({
  name: "expand", provenanceSource: "DerivativeHistory.sum", loweredKind: "expand-f32", pure: true,
});

/** Canonical metadata admission; a view introduces no numerical dependency. */
class ViewOperationDefinition {
  readonly derivative = IDENTITY_DERIVATIVE;
  admit(source: TensorState, shape: unknown): TensorMetadata {
    assertTensorOpen(source);
    return {
      shape: inferViewShape(shape, tensorElementCount(source.value.shape)),
      dtype: source.value.dtype, device: source.value.device, layout: source.value.layout,
    };
  }
}

const VIEW_OPERATION = Object.freeze(new ViewOperationDefinition());

export class RuntimeSession {
  #backend: WebAssemblyCpuBackend;
  readonly #gpuBackend: WebGpuExecutionBackend | undefined;
  readonly #history = new DerivativeHistory<TensorValue>(
    (value) => this.#retainValue(value), (value) => this.#releaseValue(value),
  );
  readonly #materializations = new MaterializationTable();
  readonly #states = new Set<TensorState>();
  readonly #values = new Set<TensorValue>();
  #requestHead: QueuedExecutionRequest | undefined;
  #requestTail: QueuedExecutionRequest | undefined;
  #advancing = false;
  #drainCompletion: { readonly promise: Promise<void>; readonly resolve: () => void } | undefined;
  #preparation: Promise<void> | undefined;
  #closed = false;
  #closePromise: Promise<void> | null = null;
  #operationRecords = 0;
  #requestLeases = 0;
  #onProgramFormed: ((program: ExecutableProgram) => void) | undefined;
  #beforeReadback: (() => void) | undefined;

  constructor(options: RuntimeSessionOptions = {}) {
    this.#gpuBackend = (options as InternalRuntimeSessionOptions)[RUNTIME_SESSION_GPU_BACKEND];
    const testConfiguration = (options as InternalRuntimeSessionOptions)[
      RUNTIME_SESSION_TEST_CONFIGURATION
    ];
    const manifestUrl = options.manifestUrl === undefined
      ? new URL("./manifest.json", import.meta.url)
      : new URL(options.manifestUrl, import.meta.url);
    this.#backend = new WebAssemblyCpuBackend(
      manifestUrl,
      testConfiguration?.forceVariant,
    );
    this.#onProgramFormed = testConfiguration?.onProgramFormed;
    this.#beforeReadback = testConfiguration?.beforeReadback;
    RUNTIME_SESSION_ACCESS.set(this, Object.freeze({
      prepare: () => this.#prepare(),
      observeSynchronously: (state: TensorState) => this.#observeSynchronously(state),
      binary: (definition: EqualShapeBinaryOperationDefinition, left: TensorState, rightHandle: unknown) => (
        this.#binary(definition, left, rightHandle)
      ),
      sum: (source: TensorState) => this.#sum(source),
      view: (source: TensorState, shape: unknown) => this.#view(source, shape),
      observe: (state: TensorState) => this.#observe(state),
      assertOpen: () => this.#assertOpen(),
      releaseHandle: (state: TensorState) => this.#releaseHandle(state),
      countResidentProgramReferences: () => (
        this.#materializations.countResidentProgramReferences()
      ),
    }));
  }

  tensor(data: Iterable<number> | ArrayLike<number>, options: TensorOptions = {}): Tensor {
    this.#assertOpen();
    if (options.requiresGrad !== undefined && typeof options.requiresGrad !== "boolean") {
      throw new TypeError("requiresGrad must be a boolean.");
    }
    if (options.dtype !== undefined && options.dtype !== "float32") {
      throw new TabgradError(
        "UNSUPPORTED_DTYPE",
        "This runtime slice supports only float32 tensors.",
        { operation: "tensor", contract: "float32-dtype", dtype: options.dtype },
      );
    }
    const device = options.device ?? "cpu";
    const backend = this.#backendFor(device, "tensor");
    if (options.requiresGrad === true) this.#requireGradients(backend, "tensor");
    if (options.layout !== undefined && options.layout !== "contiguous") {
      throw new TabgradError(
        "UNSUPPORTED_LAYOUT",
        "This runtime slice supports only contiguous tensors.",
        {
          operation: "tensor",
          contract: "contiguous-layout",
          layout: options.layout,
        },
      );
    }

    const payload = copyFloat32TensorData(data);
    if (device === "webgpu" && payload.byteLength > backend.capabilities.maximumTensorBytes) {
      throw new TabgradError("RESOURCE_EXHAUSTED", "Tensor exceeds the selected device's buffer limit.", {
        operation: "tensor", device, byteLength: payload.byteLength,
        maximumTensorBytes: backend.capabilities.maximumTensorBytes,
      });
    }
    const shape = copyTensorShape(options.shape, payload.length);
    const value = new TensorValue({
      shape,
      dtype: "float32",
      device,
      layout: "contiguous",
    }, null);
    this.#registerValue(value);
    this.#materializations.setHost(value, payload);
    return this.#createHandle(value, options.requiresGrad === true ? this.#history.leaf(value.shape) : null);
  }

  /** Return lazy first-order gradients in input order, without persistent accumulation. */
  grad(output: Tensor, inputs: readonly Tensor[], gradient?: Tensor): Tensor[] {
    this.#assertOpen();
    if (arguments.length < 2 || arguments.length > 3 || !Array.isArray(inputs) || inputs.length === 0) {
      throw new TypeError("grad requires one output and a nonempty array of input tensors, plus an optional seed.");
    }
    const result = this.#gradientInput(output);
    const requested = inputs.map((input: unknown) => this.#gradientInput(input));
    if (result.history === null || requested.some((input) => input.history === null)) {
      throw new TabgradError("GRADIENT_NOT_TRACKED", "Output and requested inputs must require gradients.");
    }
    const explicitSeed = gradient === undefined ? undefined : this.#gradientInput(gradient);
    if (explicitSeed !== undefined) {
      if (explicitSeed.history !== null) {
        throw new TabgradError("UNSUPPORTED_GRADIENT", "The gradient seed must not require gradients.");
      }
      if (!equalTensorShapes(result.value.shape, explicitSeed.value.shape)) {
        throw new TabgradError("SHAPE_MISMATCH", "The gradient seed must match the output shape.");
      }
    } else if (tensorElementCount(result.value.shape) !== 1) {
      throw new TabgradError("INVALID_GRADIENT", "An implicit gradient requires an output with exactly one element.");
    }
    const plan = this.#history.plan(result.history, requested.map((input) => input.history!));
    const seed = explicitSeed === undefined
      ? this.tensor([1], { shape: result.value.shape }) : this.#borrowValue(explicitSeed.value);
    try {
      return this.#history.execute(plan, seed, {
        borrow: (value) => this.#borrowValue(value),
        add: (left, right) => left.add(right),
        mul: (left, right) => left.mul(right),
        view: (value, shape) => value.view(shape),
        expand: (value, shape) => this.#expand(value, shape),
        close: (value) => value.close(),
      });
    } finally { seed.close(); }
  }

  #gradientInput(handle: unknown): TensorState {
    const state = requireTensorState(handle);
    assertTensorOpen(state);
    if (state.session !== this) {
      throw new TabgradError("DIFFERENT_SESSION", "Gradient tensors must belong to this session.");
    }
    this.#requireGradients(this.#backendFor(state.value.device, "grad"), "grad");
    return state;
  }

  #backendFor(device: TensorDevice, operation: string): ExecutionBackend {
    const backend = device === "cpu" ? this.#backend : device === "webgpu" ? this.#gpuBackend : undefined;
    if (backend === undefined) {
      throw new TabgradError("UNSUPPORTED_DEVICE", "The selected device is not enabled in this session.", {
        operation, device, contract: "enabled-device",
      });
    }
    backend.assertAvailable();
    return backend;
  }

  #requireGradients(backend: ExecutionBackend, operation: string): void {
    if (!backend.capabilities.gradients) {
      throw new TabgradError("UNSUPPORTED_GRADIENT", "The selected backend does not support gradients.", {
        operation, device: backend.capabilities.device,
      });
    }
  }

  #requireComputation(value: TensorValue, definition: NumericalOperationDefinition): void {
    const backend = this.#backendFor(value.device, definition.name);
    if (!backend.capabilities.computations.includes(definition.loweredKind)) {
      throw new TabgradError("BACKEND_CAPABILITY_MISMATCH", "The selected backend does not support this operation.", {
        operation: definition.name, source: definition.provenanceSource, device: value.device,
      });
    }
  }

  #borrowValue(value: TensorValue): Tensor {
    this.#retainValue(value);
    return this.#createHandle(value);
  }

  #sum(source: TensorState): Tensor {
    assertTensorOpen(source);
    this.#requireComputation(source.value, SUM_OPERATION);
    const admitted = SUM_OPERATION.admit(source);
    const history = source.history === null ? null
      : this.#history.record(admitted.outputMetadata.shape, SUM_OPERATION.derivative, [source.history], [source.value]);
    return this.#recordOperation(admitted, history);
  }

  #expand(source: Tensor, shape: readonly number[]): Tensor {
    const value = requireTensorState(source).value;
    if (tensorElementCount(value.shape) !== 1) {
      throw new TabgradError("INVALID_GRADIENT", "Scalar expansion requires a one-element input.");
    }
    return this.#recordOperation({
      record: new OperationRecord(EXPAND_OPERATION, [value]),
      outputMetadata: { shape, dtype: value.dtype, device: value.device, layout: value.layout },
    });
  }

  #binary(definition: EqualShapeBinaryOperationDefinition, left: TensorState, rightHandle: unknown): Tensor {
    this.#assertOpen();
    const admitted = definition.admit(this, left, rightHandle);
    this.#requireComputation(left.value, definition);
    const right = requireTensorState(rightHandle);
    const history = left.history === null && right.history === null ? null
      : this.#history.record(admitted.outputMetadata.shape, definition.derivative,
        [left.history, right.history], [left.value, right.value]);
    return this.#recordOperation(admitted, history);
  }

  #recordOperation(admitted: AdmittedOperation, history: DerivativeNode<TensorValue> | null = null): Tensor {
    for (const input of admitted.record.inputs) {
      this.#retainValue(input);
    }
    const result = new TensorValue(admitted.outputMetadata, admitted.record);
    this.#registerValue(result);
    return this.#createHandle(result, history);
  }

  #view(source: TensorState, shape: unknown): Tensor {
    const metadata = VIEW_OPERATION.admit(source, shape);
    this.#backendFor(source.value.device, "view");
    const value = new TensorValue(metadata, null, source.value.storage);
    value.storage.references += 1;
    this.#values.add(value);
    const history = source.history === null ? null
      : this.#history.record(value.shape, VIEW_OPERATION.derivative, [source.history], [source.value]);
    return this.#createHandle(value, history);
  }

  #prepare(): Promise<void> {
    this.#assertOpen();
    // Preparation shares the session's drain ownership, but has no tensor
    // operation or executable program to attach to a setup failure.
    this.#preparation ??= this.#enqueue(this.#prepareBackend()).asPromise();
    return this.#preparation;
  }

  *#prepareBackend(backend: ExecutionBackend = this.#backend, program?: ExecutableProgram): Generator<ExecutionStep, void, unknown> {
    const preparation = backend.prepare(program);
    if (preparation !== undefined) yield preparation;
  }

  #observe(state: TensorState): Promise<Float32Array> {
    this.#assertOpen();
    this.#retainValue(state.value);
    return this.#enqueue(this.#observation(state.value), () => this.#releaseValue(state.value)).asPromise();
  }

  #observeSynchronously(state: TensorState): Float32Array {
    this.#assertOpen();
    const host = this.#materializations.get(state.value)?.kind === "host";
    const backend = this.#backendFor(state.value.device, "observe");
    if (!backend.synchronousObservation || this.#requestHead !== undefined || (!host && !backend.ready)) {
      throw new TabgradError(
        "SYNCHRONOUS_OBSERVATION_UNAVAILABLE",
        "Synchronous observation requires local readiness and no pending asynchronous predecessor.",
      );
    }
    this.#retainValue(state.value);
    return this.#enqueue(this.#observation(state.value), () => this.#releaseValue(state.value)).read();
  }

  *#observation(value: TensorValue): Generator<ExecutionStep, Float32Array, unknown> {
    const formed = this.#formProgram(value);
    try {
      const backend = this.#backendFor(value.device, "observe");
      const host = this.#materializations.get(value);
      if (host?.kind === "host" && value.device === "cpu") {
        try {
          this.#beforeReadback?.();
          return host.data.slice();
        } catch (error) {
          throw retainProgramFailureContext(error, formed.program, "readback");
        }
      }
      try {
        yield* this.#prepareBackend(backend, formed.program);
        yield* this.#materialize(value, formed, backend);
      } catch (error) {
        throw retainProgramFailureContext(error, formed.program, "execution");
      }
      const materialization = this.#materializations.get(value);
      if (materialization?.kind !== "resident") {
        throw new TabgradError("BACKEND_STATUS_ERROR", "Observation has no resident result.");
      }
      try {
        this.#beforeReadback?.();
        return yield* awaitBackendResult(backend.read(materialization.allocation, tensorElementCount(value.shape)));
      } catch (error) {
        throw retainProgramFailureContext(error, formed.program, "readback");
      }
    } catch (error) {
      throw retainProgramFailureContext(error, formed.program, "execution");
    }
  }

  diagnostics(): RuntimeDiagnostics {
    return Object.freeze({
      ...this.#backend.diagnostics(),
      webgpu: this.#gpuBackend?.diagnostics() ?? null,
      ...this.#history.diagnostics(),
      liveTensorHandles: this.#states.size,
      liveTensorValues: this.#values.size,
      liveOperationRecords: this.#operationRecords,
      liveMaterializationRecords: this.#materializations.size,
      liveRequestLeases: this.#requestLeases,
    });
  }

  close(): Promise<void> {
    if (this.#closePromise !== null) {
      return this.#closePromise;
    }
    this.#closed = true;
    for (const state of [...this.#states]) {
      if (!state.closed) {
        state.closed = true;
        this.#releaseHandle(state);
      }
    }
    this.#closePromise = this.#finishClose();
    return this.#closePromise;
  }

  async #finishClose(): Promise<void> {
    await this.#drainRequests();
    for (const materialization of this.#materializations.values()) {
      if (materialization.kind === "resident") {
        materialization.backend.release(materialization.allocation);
      }
    }
    this.#materializations.clear();
    await this.#backend.close();
    await this.#gpuBackend?.close();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new TabgradError("CLOSED_SESSION", "The runtime session is closed.");
    }
  }

  #releaseHandle(state: TensorState): void {
    this.#states.delete(state);
    if (state.history !== null) this.#history.release(state.history);
    this.#releaseValue(state.value);
  }

  #createHandle(value: TensorValue, history: DerivativeNode<TensorValue> | null = null): Tensor {
    const state = new TensorState(this, value, history);
    this.#states.add(state);
    return createTensorHandle(state);
  }

  #registerValue(value: TensorValue): void {
    this.#values.add(value);
    if (value.producer !== null) {
      this.#operationRecords += 1;
    }
  }

  #retainValue(value: TensorValue): void {
    value.references += 1;
    value.storage.references += 1;
  }

  #releaseValue(value: TensorValue): void {
    // Entries represent owning references, not distinct values: repeated
    // input positions must each be released, even when they share a value.
    const pending = [value];
    while (pending.length > 0) {
      const current = pending.pop()!;
      current.references -= 1;
      current.storage.references -= 1;
      if (current.references < 0) {
        throw new TabgradError(
          "BACKEND_STATUS_ERROR",
          "A tensor value was released more times than it was retained.",
        );
      }
      if (current.references === 0) this.#values.delete(current);
      if (current.storage.references > 0) continue;
      const materialization = this.#materializations.delete(current);
      if (materialization?.kind === "resident") {
        materialization.backend.release(materialization.allocation);
      }
      const producer = this.#detachProducer(current);
      if (producer !== null) {
        // Reverse insertion preserves depth-first, left-to-right release.
        for (let index = producer.inputs.length - 1; index >= 0; index -= 1) {
          pending.push(producer.inputs[index]!);
        }
      }
    }
  }

  #detachProducer(value: TensorValue): OperationRecord | null {
    const producer = value.producer;
    if (producer === null) {
      return null;
    }
    // Sever the strong edge as well as its logical ownership. Keeping a
    // released record attached would retain its entire upstream object graph.
    value.storage.producer = null;
    this.#operationRecords -= 1;
    return producer;
  }

  #releaseDependencies(value: TensorValue): void {
    const producer = this.#detachProducer(value);
    if (producer === null) return;
    for (const input of producer.inputs) {
      this.#releaseValue(input);
    }
  }

  *#materialize(value: TensorValue, formed: FormedProgram<TensorValue>, backend: ExecutionBackend): Generator<ExecutionStep, void, unknown> {
    const existing = this.#materializations.get(value);
    if (existing?.kind === "resident") {
      return;
    }
    try {
      // Preparation can suspend. Capture current external owners only at this
      // synchronous admission boundary, not in immutable program formation.
      const retainedSlots = new Array<boolean>(formed.program.values.length);
      for (const [slot, selectedValue] of formed.valuesBySlot) {
        if (formed.program.values[slot]!.storageSlot === slot) {
          retainedSlots[slot] = selectedValue.storage.references > formed.program.storageUseCounts[slot]!;
        }
      }
      const allocations = yield* awaitBackendResult(backend.execute(formed.program, formed.bindings, retainedSlots));
      for (const [slot, allocation] of allocations) {
        const boundValue = formed.valuesBySlot.get(slot);
        if (boundValue === undefined) {
          throw new TabgradError(
            "BACKEND_STATUS_ERROR",
            "The backend returned an allocation for an unknown program slot.",
            { backend: formed.program.domain, phase: "execution", slot },
          );
        }
        const existingMaterialization = this.#materializations.get(boundValue);
        if (existingMaterialization?.kind === "resident") {
          if (existingMaterialization.allocation !== allocation) {
            throw new TabgradError(
              "BACKEND_STATUS_ERROR",
              "The backend replaced a live resident allocation.",
              {
                backend: formed.program.domain,
                phase: "execution",
                slot,
              },
            );
          }
          continue;
        }
        this.#materializations.setResident(boundValue, allocation, backend);
      }
      for (const computedValue of formed.newlyComputed) {
        this.#releaseDependencies(computedValue);
      }
      const result = this.#materializations.get(value);
      if (result?.kind !== "resident") {
        throw new TabgradError(
          "BACKEND_STATUS_ERROR",
          "Execution completed without materializing the demanded result.",
          { backend: formed.program.domain, phase: "execution" },
        );
      }
    } catch (error) {
      throw retainProgramFailureContext(error, formed.program, "execution");
    }
  }

  #formProgram(root: TensorValue): FormedProgram<TensorValue> {
    const formed = formExecutableProgram(root, this.#materializations);
    this.#onProgramFormed?.(formed.program);
    return formed;
  }

  #enqueue<T>(steps: Generator<ExecutionStep, T, unknown>, release?: () => void): ExecutionRequest<T> {
    const request = new ExecutionRequest(
      steps,
      () => this.#advanceRequests(),
      () => this.#publishRequest(request),
      () => {
        release?.();
        this.#requestLeases -= 1;
        if (this.#requestLeases === 0) {
          this.#drainCompletion?.resolve();
          this.#drainCompletion = undefined;
        }
      },
    );
    this.#requestLeases += 1;
    if (this.#requestTail === undefined) this.#requestHead = request;
    else this.#requestTail.next = request;
    this.#requestTail = request;
    this.#advanceRequests();
    return request;
  }

  #advanceRequests(): void {
    if (this.#advancing) return;
    this.#advancing = true;
    try {
      while (this.#requestHead !== undefined) {
        const current = this.#requestHead;
        current.advance();
        if (this.#requestHead === current) break;
      }
    } finally {
      this.#advancing = false;
    }
  }

  #publishRequest(request: QueuedExecutionRequest): void {
    this.#requestHead = request.next;
    request.next = undefined;
    if (this.#requestHead === undefined) {
      this.#requestTail = undefined;
    }
  }

  #drainRequests(): Promise<void> {
    if (this.#requestLeases === 0) return Promise.resolve();
    if (this.#drainCompletion === undefined) {
      let resolve!: () => void;
      const promise = new Promise<void>((onDrained) => { resolve = onDrained; });
      this.#drainCompletion = { promise, resolve };
    }
    return this.#drainCompletion.promise;
  }
}

export function createRuntimeSession(options: RuntimeSessionOptions = {}): RuntimeSession {
  return new RuntimeSession(options);
}

/** Acquire a ready, session-owned WebGPU device while preserving the CPU default. */
export async function createWebGpuRuntimeSession(
  options: WebGpuRuntimeSessionOptions = {},
): Promise<RuntimeSession> {
  const device = await acquireWebGpuDevice(options.setupAbortSignal);
  try {
    const backend = new WebGpuBackend(device);
    // Observe a loss already delivered with acquisition before publishing readiness.
    await Promise.resolve();
    assertWebGpuSetupActive(options.setupAbortSignal);
    backend.assertAvailable();
    return new RuntimeSession({ ...options, [RUNTIME_SESSION_GPU_BACKEND]: backend } as InternalRuntimeSessionOptions);
  } catch (error) {
    device.destroy();
    throw error;
  }
}

/** Yield only an actual suspension; prepared local CPU work remains synchronous. */
function* awaitBackendResult<T>(result: T | ExecutionTicket<T>): Generator<ExecutionStep, T, unknown> {
  if (!(result instanceof ExecutionTicket)) return result;
  return (yield result) as T;
}

/** @internal Prepare the owned backend before entering a synchronous frontend. */
export function prepareRuntimeSession(session: RuntimeSession): Promise<void> {
  return runtimeSessionAccess(session).prepare();
}

/** @internal Attach a library-owned physical connection, not a public backend SPI. */
export function createConnectedRuntimeSession(backend: WebGpuExecutionBackend): RuntimeSession {
  return new RuntimeSession({ [RUNTIME_SESSION_GPU_BACKEND]: backend } as InternalRuntimeSessionOptions);
}

/** @internal Observe an opaque handle through its owning session's common request path. */
export function observeTensorSynchronously(session: RuntimeSession, handle: unknown): Float32Array {
  const state = requireTensorState(handle);
  assertTensorOpen(state);
  if (state.session !== session) {
    throw new TabgradError("DIFFERENT_SESSION", "Observation requires a tensor from this session.");
  }
  return runtimeSessionAccess(session).observeSynchronously(state);
}

/** @internal */
export function createRuntimeSessionForTesting(
  options: RuntimeSessionOptions & { readonly forceVariant: WasmVariant },
  onProgramFormed?: (program: ExecutableProgram) => void,
  beforeReadback?: () => void,
): RuntimeSession {
  const testConfiguration: RuntimeSessionTestConfiguration = {
    forceVariant: options.forceVariant,
    ...(onProgramFormed === undefined ? {} : { onProgramFormed }),
    ...(beforeReadback === undefined ? {} : { beforeReadback }),
  };
  return new RuntimeSession({
    ...options,
    [RUNTIME_SESSION_TEST_CONFIGURATION]: testConfiguration,
  } as InternalRuntimeSessionOptions);
}

/** @internal */
export function countResidentProgramReferencesForTesting(
  session: RuntimeSession,
): number {
  return runtimeSessionAccess(session).countResidentProgramReferences();
}

/** @internal Inspect actual strong dependency edges, including closed handles. */
export function inspectTensorAncestryForTesting(handle: Tensor): {
  readonly values: number;
  readonly operations: number;
  readonly releasedValues: number;
} {
  const pending = [requireTensorState(handle).value];
  const seen = new Set<TensorValue>();
  let operations = 0;
  let releasedValues = 0;
  while (pending.length > 0) {
    const value = pending.pop()!;
    if (seen.has(value)) continue;
    seen.add(value);
    if (value.references === 0) releasedValues += 1;
    if (value.producer !== null) {
      operations += 1;
      pending.push(...value.producer.inputs);
    }
  }
  return { values: seen.size, operations, releasedValues };
}
