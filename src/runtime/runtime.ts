import { TensorValue, OperationRecord, type StorageState, type TensorMetadata, type NumericalOperationDefinition } from "./tensor-value.js";
import { TensorFamily, TensorIdentity, TensorState } from "./tensor-family.js";
import { WriterOutcome, WriterOutcomeLedger, type EffectFailure, captureWriterOutcomes, retainWriterOutcomes,
  releaseWriterOutcomes, failedWriterOutcome } from "./writer-outcome.js";
import {
  type WasmVariant,
  WebAssemblyCpuBackend,
} from "../backends/cpu/cpu-backend.js";
import {
  TabgradError,
  retainExecutionFailureContext,
  throwCleanupFailures,
} from "../shared/errors.js";
import { ExecutionRequest, type QueuedExecutionRequest } from "./execution-request.js";
import { ExecutionTicket, type ExecutionStep } from "../execution/execution-ticket.js";
import { acquireWebGpuDevice, assertWebGpuSetupActive } from "../backends/webgpu/webgpu-device.js";
import type { ExecutionBackend, ResidentAllocation, TensorDevice } from "../execution/backend.js";
import { WebGpuBackend, type WebGpuDiagnostics, type WebGpuExecutionBackend } from "../backends/webgpu/webgpu-backend.js";
export type { TensorDevice } from "../execution/backend.js";
import { DerivativeHistory, type DerivativeNode, type DerivativeRecipe } from "./autograd/derivative-history.js";
import { COPY_DERIVATIVE, COPY_SLICES_DERIVATIVE, IDENTITY_DERIVATIVE, PASS_DERIVATIVE, MUL_DERIVATIVE, SUM_DERIVATIVE } from "./autograd/derivative-recipes.js";
import { copyTensorShape, equalTensorShapes, inferViewShape, tensorElementCount } from "./tensor-shape.js";
import { createSGD, type SGD, type SGDOptions, type SGDParameterGroup } from "./sgd.js";
import type { OptimizerLease } from "./optimizer-lease.js";
import {
  ExecutableProgram,
  type ProgramProvenance,
} from "../execution/executable-program.js";
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

interface AdmittedOperation {
  readonly record: OperationRecord;
  readonly outputMetadata: TensorMetadata;
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

/** Fixed production update capacities; smaller test capacities exercise the same admission. */
interface UpdateLimits {
  readonly pendingCopies: number;
  readonly owners: number;
  readonly backingBytes: number;
}
const DEFAULT_UPDATE_LIMITS: UpdateLimits = Object.freeze({
  pendingCopies: 1024,
  owners: 65536,
  backingBytes: 64 * 1024 * 1024,
});

interface RuntimeSessionTestConfiguration {
  readonly forceVariant: WasmVariant;
  readonly onProgramFormed?: (program: ExecutableProgram) => void;
  readonly beforeReadback?: () => void;
  readonly beforeCopyPublication?: () => void;
  readonly updateLimits?: Partial<UpdateLimits>;
}

const RUNTIME_SESSION_TEST_CONFIGURATION = Symbol("RuntimeSessionTestConfiguration");
const RUNTIME_SESSION_GPU_BACKEND = Symbol("RuntimeSessionGpuBackend");

interface InternalRuntimeSessionOptions extends RuntimeSessionOptions {
  readonly [RUNTIME_SESSION_TEST_CONFIGURATION]?: RuntimeSessionTestConfiguration;
  readonly [RUNTIME_SESSION_GPU_BACKEND]?: WebGpuExecutionBackend;
}

interface RuntimeOwnership {
  readonly families: number;
  readonly backings: number;
  readonly backingBytes: number;
  readonly valueReferences: number;
  readonly derivativeReferences: number;
  readonly writerOutcomes: number;
  readonly controlReferences: number;
  readonly pendingCopies: number;
  readonly undeliveredEffects: number;
}

interface RuntimeSemanticOwnership {
  readonly identities: number;
  readonly identityReferences: number;
  readonly gradientAssociations: number;
  readonly viewBaseReferences: number;
  readonly leafEndpointOwners: number;
  readonly nonleafEntryOwners: number;
  readonly publicExposures: number;
  readonly optimizerOccurrences: number;
  readonly optimizerRegistrations: number;
  readonly collectorPasses: number;
  readonly collectorVisitedIdentities: number;
  readonly collectorVisitedHistoryNodes: number;
  readonly collectorVisitedEdges: number;
}

interface RuntimeSessionAccess {
  readonly registerOptimizer: (groups: readonly (readonly Tensor[])[]) => OptimizerLease;
  readonly gradient: (state: TensorState) => Tensor | null;
  readonly assignGradient: (state: TensorState, value: unknown) => void;
  readonly backward: (state: TensorState, gradient: unknown, options: unknown) => void;
  readonly recordingMode: () => boolean;
  readonly enterNoGrad: () => boolean;
  readonly restoreRecording: (previous: boolean) => void;
  readonly prepare: () => Promise<void>;
  readonly complete: () => Promise<void>;
  readonly observeSynchronously: (state: TensorState) => Float32Array;
  readonly binary: (definition: EqualShapeBinaryOperationDefinition, left: TensorState, rightHandle: unknown) => Tensor;
  readonly ownership: () => RuntimeOwnership;
  readonly semanticOwnership: () => RuntimeSemanticOwnership;
  readonly copy: (destination: TensorState, source: unknown) => void;
  readonly sum: (source: TensorState) => Tensor;
  readonly view: (source: TensorState, shape: unknown) => Tensor;
  readonly observe: (state: TensorState) => Promise<Float32Array>;
  readonly assertOpen: () => void;
  readonly releaseHandle: (state: TensorState) => void;
  readonly finalizeHandle: (state: TensorState) => void;
  readonly countResidentProgramReferences: () => number;
}

const RUNTIME_SESSION_ACCESS = new WeakMap<RuntimeSession, RuntimeSessionAccess>();

interface OptimizerRegistration {
  closed: boolean;
  readonly groups: readonly (readonly TensorState[])[];
}

const COEFFICIENT_ADD_OPERATION: NumericalOperationDefinition = Object.freeze({
  name: "add", provenanceSource: "SGD.step", loweredKind: "add-alpha-f32", pure: true,
});

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
const TENSOR_FINALIZER = new FinalizationRegistry<TensorState>((state) => {
  state.finalizerRegistered = false;
  if (!state.closed) {
    state.closed = true;
    runtimeSessionAccess(state.session).finalizeHandle(state);
  }
});

let pendingTensorFinalizers: Array<readonly [Tensor, TensorState]> | undefined;

function enrollTensorFinalizer(handle: Tensor, state: TensorState): void {
  TENSOR_FINALIZER.register(handle, state, state);
  state.finalizerRegistered = true;
}

function registerTensorFinalizer(handle: Tensor, state: TensorState): void {
  if (pendingTensorFinalizers === undefined) enrollTensorFinalizer(handle, state);
  else pendingTensorFinalizers.push([handle, state]);
}

function unregisterTensorFinalizer(state: TensorState): void {
  if (!state.finalizerRegistered) return;
  state.finalizerRegistered = false;
  TENSOR_FINALIZER.unregister(state);
}

function withTensorFinalizerScope<T>(callback: () => T): T {
  const previous = pendingTensorFinalizers;
  const pending: Array<readonly [Tensor, TensorState]> = [];
  pendingTensorFinalizers = pending;
  try { return callback(); }
  finally {
    pendingTensorFinalizers = previous;
    // Synchronous differentiation owns these strong references only until the
    // outer call returns or throws. Reentrant calls transfer open survivors;
    // every survivor is enrolled before control leaves the outermost call.
    for (const [handle, state] of pending) {
      if (state.closed) continue;
      if (previous === undefined) enrollTensorFinalizer(handle, state);
      else previous.push([handle, state]);
    }
  }
}

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

/** @internal Inspect grad-read metadata without resolving a dirty view entry. */
export function shouldWarnUnretainedGradient(handle: Tensor): boolean {
  const state = requireTensorState(handle);
  assertTensorOpen(state);
  const identity = state.identity;
  return identity.gradient === null && !identity.retained && identity.entry?.recipe != null;
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
    registerTensorFinalizer(this, state);
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

  /** Advertised tracking, including no-grad views with no derivative accumulator. */
  get requiresGrad(): boolean {
    const state = requireTensorState(this);
    assertTensorOpen(state);
    return state.requiresGrad;
  }

  get grad(): Tensor | null {
    const state = requireTensorState(this);
    assertTensorOpen(state);
    return runtimeSessionAccess(state.session).gradient(state);
  }

  set grad(value: Tensor | null) {
    const state = requireTensorState(this);
    assertTensorOpen(state);
    runtimeSessionAccess(state.session).assignGradient(state, value);
  }

  /** Accumulate first-order CPU gradients, preserving accepted lazy effects. */
  backward(gradient?: Tensor, options?: BackwardOptions): void {
    if (arguments.length > 2) throw new TypeError("backward accepts a seed and options.");
    const state = requireTensorState(this);
    runtimeSessionAccess(state.session).backward(state, gradient, options);
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

  /** Replace this alias family's current CPU value and return the same handle. */
  copy_(source: Tensor): this {
    if (arguments.length !== 1) throw new TypeError("copy_ requires exactly one tensor.");
    const state = requireTensorState(this);
    runtimeSessionAccess(state.session).copy(state, source);
    return this;
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
      unregisterTensorFinalizer(state);
      runtimeSessionAccess(state.session).releaseHandle(state);
    }
  }
}

export interface BackwardOptions {
  readonly inputs?: readonly Tensor[];
  readonly retainGraph?: boolean;
  readonly createGraph?: boolean;
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
    const leftValue = left.value;
    const rightValue = right.value;
    if (leftValue.dtype !== "float32" || rightValue.dtype !== "float32") {
      throw new TabgradError(
        "UNSUPPORTED_DTYPE",
        `Float32 ${this.description} requires float32 inputs.`,
        {
          operation: this.name,
          contract: "float32-inputs",
          leftDType: leftValue.dtype,
          rightDType: rightValue.dtype,
        },
      );
    }
    if (leftValue.device !== rightValue.device) {
      throw new TabgradError(
        "UNSUPPORTED_DEVICE",
        `Both ${this.description} inputs must be on the same device.`,
        {
          operation: this.name,
          contract: "same-device",
          device: "webgpu",
          leftDevice: leftValue.device,
          rightDevice: rightValue.device,
        },
      );
    }
    if (leftValue.layout !== "contiguous" || rightValue.layout !== "contiguous") {
      throw new TabgradError(
        "UNSUPPORTED_LAYOUT",
        `This ${this.description} definition supports only contiguous inputs.`,
        {
          operation: this.name,
          contract: "contiguous-inputs",
          leftLayout: leftValue.layout,
          rightLayout: rightValue.layout,
        },
      );
    }
    if (!equalTensorShapes(leftValue.shape, rightValue.shape)) {
      throw new TabgradError(
        "SHAPE_MISMATCH",
        `Float32 ${this.description} requires equal shapes.`,
        {
          operation: this.name,
          contract: "equal-shape",
          leftShape: leftValue.shape,
          rightShape: rightValue.shape,
        },
      );
    }

    const inputs = [
      leftValue,
      rightValue,
    ];
    return Object.freeze({
      record: new OperationRecord(this, inputs),
      outputMetadata: Object.freeze({
        shape: leftValue.shape,
        dtype: leftValue.dtype,
        device: leftValue.device,
        layout: leftValue.layout,
      }),
    });
  }
}

const ADD_OPERATION = Object.freeze(new EqualShapeBinaryOperationDefinition(
  "add", "Tensor.add", "add-f32", "addition", PASS_DERIVATIVE,
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
    const value = source.value;
    // Backend support is checked by the session before recording this result.
    return Object.freeze({
      record: new OperationRecord(this, [value]),
      outputMetadata: Object.freeze({
        shape: Object.freeze([]), dtype: value.dtype,
        device: value.device, layout: value.layout,
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
    const value = source.value;
    return {
      shape: inferViewShape(shape, tensorElementCount(value.shape)),
      dtype: value.dtype, device: value.device, layout: value.layout,
    };
  }
}

const VIEW_OPERATION = Object.freeze(new ViewOperationDefinition());

function isPromiseLike<Result>(value: Result | PromiseLike<Result>): value is PromiseLike<Result> {
  return value !== null && (typeof value === "object" || typeof value === "function")
    && "then" in value && typeof value.then === "function";
}

export class RuntimeSession {
  #backend: WebAssemblyCpuBackend;
  readonly #gpuBackend: WebGpuExecutionBackend | undefined;
  readonly #history = new DerivativeHistory<TensorValue>(
    (value) => this.#retainValue(value), (value) => this.#releaseValue(value),
    (value) => this.#validateSavedValue(value),
    (value) => value.outcomes,
    (owner) => this.#retainIdentity(owner as TensorIdentity),
    (owner) => this.#releaseIdentity(owner as TensorIdentity),
  );
  #cleanupFailures: unknown[] | undefined;
  readonly #undeliveredEffects = new Set<EffectFailure>();
  #mutationFailure: EffectFailure | undefined;
  readonly #writers = new WriterOutcomeLedger();
  #valueReferences = 0;
  #liveBackingBytes = 0;
  #pendingCopies = 0;
  #copyCompletion: { readonly promise: Promise<void>; readonly resolve: () => void } | undefined;
  readonly #updateLimits: UpdateLimits;
  readonly #beforeCopyPublication: (() => void) | undefined;
  readonly #materializations = new MaterializationTable();
  readonly #states = new Set<TensorState>();
  readonly #identities = new Set<TensorIdentity>();
  readonly #optimizers = new Set<OptimizerRegistration>();
  #optimizerOccurrences = 0;
  readonly #retainedEntries = new WeakMap<DerivativeNode<TensorValue>, WeakRef<TensorIdentity>>();
  #associationOwners = 0;
  #identityReferences = 0;
  #collectorPasses = 0;
  #collectorVisitedIdentities = 0;
  #collectorVisitedHistoryNodes = 0;
  #collectorVisitedEdges = 0;
  #collectionScheduled = false;
  #retiring = false;
  readonly #retirementQueue: (TensorIdentity | TensorValue)[] = [];
  readonly #values = new Set<TensorValue>();
  #requestHead: QueuedExecutionRequest | undefined;
  #requestTail: QueuedExecutionRequest | undefined;
  #advancing = false;
  #drainCompletion: { readonly promise: Promise<void>; readonly resolve: () => void } | undefined;
  #preparation: Promise<void> | undefined;
  #closed = false;
  #recording = true;
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
    // Preserve the original distribution-root URL base, including empty,
    // query-only and fragment-only strings. This anchor is not a module import.
    const manifestBaseUrl = new URL("../runtime.js", import.meta.url);
    const manifestUrl = options.manifestUrl === undefined
      ? new URL("./manifest.json", manifestBaseUrl)
      : new URL(options.manifestUrl, manifestBaseUrl);
    this.#backend = new WebAssemblyCpuBackend(
      manifestUrl,
      testConfiguration?.forceVariant,
    );
    this.#onProgramFormed = testConfiguration?.onProgramFormed;
    this.#beforeReadback = testConfiguration?.beforeReadback;
    this.#beforeCopyPublication = testConfiguration?.beforeCopyPublication;
    this.#updateLimits = Object.freeze({ ...DEFAULT_UPDATE_LIMITS, ...testConfiguration?.updateLimits });
    for (const limit of Object.values(this.#updateLimits)) {
      if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError("Update limits must be nonnegative safe integers.");
    }
    RUNTIME_SESSION_ACCESS.set(this, Object.freeze({
      registerOptimizer: (groups: readonly (readonly Tensor[])[]) => this.#registerOptimizer(groups),
      gradient: (state: TensorState) => state.identity.gradient === null ? null : this.#expose(state.identity.gradient),
      assignGradient: (state: TensorState, value: unknown) => this.#assignGradient(state, value),
      backward: (state: TensorState, gradient: unknown, options: unknown) => this.#backward(state, gradient, options),
      recordingMode: () => { this.#assertOpen(); return this.#recording; },
      enterNoGrad: () => this.#enterNoGrad(),
      restoreRecording: (previous: boolean) => { this.#recording = previous; },
      prepare: () => this.#prepare(),
      complete: () => this.#complete(),
      observeSynchronously: (state: TensorState) => this.#observeSynchronously(state),
      binary: (definition: EqualShapeBinaryOperationDefinition, left: TensorState, rightHandle: unknown) => (
        this.#binary(definition, left, rightHandle)
      ),
      ownership: () => this.#ownership(),
      semanticOwnership: () => this.#semanticOwnership(),
      copy: (destination: TensorState, source: unknown) => this.#copy(destination, source),
      sum: (source: TensorState) => this.#sum(source),
      view: (source: TensorState, shape: unknown) => this.#view(source, shape),
      observe: (state: TensorState) => this.#observe(state),
      assertOpen: () => this.#assertOpen(),
      releaseHandle: (state: TensorState) => this.#releaseHandle(state),
      finalizeHandle: (state: TensorState) => {
        try { this.#releaseHandle(state); }
        catch (error) { (this.#cleanupFailures ??= []).push(error); }
      },
      countResidentProgramReferences: () => (
        this.#materializations.countResidentProgramReferences()
      ),
    }));
  }

  /** Construct basic CPU SGD without copying parameter payloads. */
  sgd(parameters: Tensor[] | SGDParameterGroup[], options?: SGDOptions): SGD {
    this.#assertOpen();
    if (arguments.length > 2) throw new TypeError("sgd requires parameters and optional options.");
    return createSGD(parameters, options, (groups) => this.#registerOptimizer(groups));
  }

  #registerOptimizer(groups: readonly (readonly Tensor[])[]): OptimizerLease {
    this.#assertOpen();
    const previousGroups = new Set<TensorIdentity>();
    const states = groups.map((group) => {
      const identities = new Set<TensorIdentity>();
      const members = group.map((handle) => {
        const state = requireTensorState(handle);
        assertTensorOpen(state);
        if (state.session !== this) throw new TabgradError("DIFFERENT_SESSION", "SGD parameters must belong to this session.");
        this.#requireGradients(this.#backendFor(state.value.device, "SGD"), "SGD");
        if (state.history?.recipe !== null && state.history !== null && !state.identity.retained) {
          throw new TabgradError("INVALID_TENSOR", "Cannot optimize a non-leaf tensor without retained gradients.");
        }
        if (previousGroups.has(state.identity)) throw new TabgradError("INVALID_TENSOR", "A parameter appears in more than one group.");
        identities.add(state.identity);
        return state;
      });
      for (const identity of identities) previousGroups.add(identity);
      return Object.freeze(members);
    });
    const occurrences = states.reduce((count, group) => count + group.length, 0);
    this.#checkUpdateCapacity(occurrences + 1);
    const registration: OptimizerRegistration = { closed: false, groups: Object.freeze(states) };
    for (const group of states) for (const state of group) this.#retainIdentity(state.identity);
    this.#optimizerOccurrences += occurrences;
    this.#optimizers.add(registration);
    const assertOpen = () => {
      this.#assertOpen();
      if (registration.closed) throw new TabgradError("CLOSED_OPTIMIZER", "The optimizer is closed.");
      for (const group of registration.groups) for (const state of group) assertTensorOpen(state);
    };
    return Object.freeze({
      assertOpen,
      beginStep: () => { assertOpen(); return this.#enterNoGrad(); },
      setRecording: (recording: boolean) => { this.#recording = recording; },
      hasGradients: (index: number) => {
        assertOpen();
        const parameters = registration.groups[index];
        if (parameters === undefined) throw new TypeError("Invalid SGD group.");
        return parameters.some((state) => state.identity.gradient !== null);
      },
      stepGroup: (index: number, alphaBits: number) => {
        assertOpen();
        const parameters = registration.groups[index];
        if (parameters === undefined) throw new TypeError("Invalid SGD group.");
        // Native setup collects identities, while each arithmetic operation
        // captures the current numerical values in sequential parameter order.
        const gradients = parameters.map((state) => state.identity.gradient);
        for (let occurrence = 0; occurrence < parameters.length; occurrence += 1) {
          const gradient = gradients[occurrence];
          if (gradient !== null && gradient !== undefined) {
            this.#optimizerUpdate(parameters[occurrence]!, gradient, alphaBits);
          }
        }
      },
      zeroGrad: (setToNone: boolean) => {
        assertOpen();
        for (const group of registration.groups) for (const state of group) {
          if (setToNone) this.#replaceGradient(state.identity, null);
          else if (state.identity.gradient !== null) this.#resetGradient(state.identity.gradient);
        }
      },
      close: () => this.#retireOptimizer(registration),
      finalize: () => {
        try { this.#retireOptimizer(registration); }
        catch (error) { (this.#cleanupFailures ??= []).push(error); }
      },
    });
  }

  #retireOptimizer(registration: OptimizerRegistration): void {
    if (registration.closed) return;
    registration.closed = true;
    this.#optimizers.delete(registration);
    let failures: unknown[] | undefined;
    for (const group of registration.groups) for (const state of group) {
      this.#optimizerOccurrences -= 1;
      try { this.#releaseIdentity(state.identity); }
      catch (error) { (failures ??= []).push(error); }
    }
    this.#scheduleCollection();
    throwCleanupFailures(failures, "Optimizer occurrence retirement failed.");
  }

  #optimizerUpdate(parameter: TensorState, gradient: TensorIdentity, alphaBits: number): void {
    const inputs = [parameter.value, gradient.value];
    this.#requireComputation(inputs[0]!, COEFFICIENT_ADD_OPERATION);
    this.#checkCapturedAdmission(inputs, parameter.shape);
    const result = this.#recordOperation({
      record: new OperationRecord(COEFFICIENT_ADD_OPERATION, inputs, alphaBits),
      outputMetadata: inputs[0]!,
    });
    let failures: unknown[] | undefined;
    try { this.#copy(parameter, result); }
    catch (error) { (failures ??= []).push(error); }
    try { result.close(); }
    catch (error) { (failures ??= []).push(error); }
    throwCleanupFailures(failures, "SGD update and temporary retirement failed.");
  }

  #resetGradient(identity: TensorIdentity): void {
    const state = new TensorState(this, identity, (state) => this.#resolveHistory(state));
    const history = state.history;
    if (this.#recording && state.specialView && state.requiresGrad) {
      throw new TabgradError("INPLACE_VIEW", "A view created in no_grad cannot change gradient metadata while recording.");
    }
    if (history !== null && history.recipe !== null) {
      if (identity.isView) throw new TabgradError("INPLACE_VIEW", "Cannot detach a gradient view in place.");
      identity.detachmentCounter.value += 1;
      this.#moveRetention(identity, history, null);
      identity.entry = null;
      identity.requiresGrad = false;
      this.#history.release(history);
    } else if (!identity.trueLeaf) identity.entry = null;
    identity.requiresGrad = false;
    const scalar = this.tensor([0]);
    let zeros: Tensor | undefined;
    let failures: unknown[] | undefined;
    try {
      zeros = this.#expand(scalar, identity.shape);
      const previous = this.#enterNoGrad();
      try { this.#copy(state, zeros); }
      finally { this.#recording = previous; }
    } catch (error) { (failures ??= []).push(error); }
    try { zeros?.close(); } catch (error) { (failures ??= []).push(error); }
    try { scalar.close(); } catch (error) { (failures ??= []).push(error); }
    throwCleanupFailures(failures, "Gradient reset and temporary retirement failed.");
  }

  /** Disable new derivative recording until this callback returns or settles. */
  noGrad<Result>(callback: () => PromiseLike<Result>): Promise<Result>;
  noGrad<Result>(callback: () => Result): Result;
  noGrad<Result>(callback: () => Result | PromiseLike<Result>): Result | Promise<Result> {
    this.#assertOpen();
    if (arguments.length !== 1 || typeof callback !== "function") {
      throw new TypeError("noGrad requires exactly one callback.");
    }
    const previous = this.#enterNoGrad();
    try {
      const result = callback();
      if (isPromiseLike(result)) return this.#settleNoGrad(result, previous);
      this.#recording = previous;
      return result;
    } catch (error) {
      this.#recording = previous;
      throw error;
    }
  }

  #settleNoGrad<Result>(result: PromiseLike<Result>, previous: boolean): Promise<Result> {
    // This continuation captures the mode owner and previous boolean, not the
    // callback or its arguments. Restoration also works after session close.
    return Promise.resolve(result).finally(() => { this.#recording = previous; });
  }

  #enterNoGrad(): boolean {
    this.#assertOpen();
    const previous = this.#recording;
    this.#recording = false;
    return previous;
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
    const handle = this.#createHandle(value, null, options.requiresGrad === true);
    if (options.requiresGrad === true) {
      const identity = requireTensorState(handle).identity;
      identity.entry = this.#history.leaf(value.shape, identity);
    }
    return handle;
  }

  /** Return lazy first-order gradients without automatic leaf accumulation. */
  grad(output: Tensor, inputs: readonly Tensor[], gradient?: Tensor): Tensor[] {
    const argumentCount = arguments.length;
    return withTensorFinalizerScope(() => this.#gradImpl(output, inputs, gradient, argumentCount));
  }

  #gradImpl(output: Tensor, inputs: readonly Tensor[], gradient: Tensor | undefined, argumentCount: number): Tensor[] {
    this.#assertOpen();
    if (argumentCount < 2 || argumentCount > 3 || !Array.isArray(inputs) || inputs.length === 0) {
      throw new TypeError("grad requires one output and a nonempty array of input tensors, plus an optional seed.");
    }
    const result = this.#gradientInput(output);
    const requested = inputs.map((input: unknown) => this.#gradientInput(input));
    if (result.history === null || requested.some((input) => !input.requiresGrad)) {
      throw new TabgradError("GRADIENT_NOT_TRACKED", "Output and requested inputs must require gradients.");
    }
    const explicitSeed = gradient === undefined ? undefined : this.#gradientInput(gradient);
    if (explicitSeed !== undefined) {
      if (explicitSeed.requiresGrad) {
        throw new TabgradError("UNSUPPORTED_GRADIENT", "The gradient seed must not require gradients.");
      }
      if (!equalTensorShapes(result.value.shape, explicitSeed.value.shape)) {
        throw new TabgradError("SHAPE_MISMATCH", "The gradient seed must match the output shape.");
      }
    } else if (tensorElementCount(result.value.shape) !== 1) {
      throw new TabgradError("INVALID_GRADIENT", "An implicit gradient requires an output with exactly one element.");
    }
    // A tracked no-grad view is an unused input, never a fabricated leaf.
    if (requested.some((input) => input.history === null)) {
      throw new TabgradError("UNUSED_INPUT", "A requested input has no derivative accumulator.");
    }
    const plan = this.#history.plan(result.history, requested.map((input) => input.history!));
    const destinations = new Set<TensorIdentity>();
    const effects = this.#reserveGradientEffects(plan.order, destinations);
    const effectControls = this.#gradientControlBound(plan.order, destinations, effects);
    const outcomes = captureWriterOutcomes([result.value.outcomes, ...plan.outcomes, explicitSeed?.value.outcomes ?? []]);
    if (outcomes.length !== 0 || effects !== 0) {
      // Reserve a conservative bound for all contributions before seed admission
      // or consumption. Each binary recipe emits at most two contributions and
      // their additions; counting all of them also bounds the transient peak.
      const additionalBytes = (explicitSeed === undefined ? 4 : 0)
        + plan.order.reduce((bytes, node) => bytes + tensorElementCount(node.shape) * 20, 0);
      this.#checkUpdateCapacity((plan.order.length * 20 + requested.length * 4 + 10) * (outcomes.length + effectControls + 1), additionalBytes);
    }
    const seed = explicitSeed === undefined
      ? this.tensor([1], { shape: result.value.shape }) : this.#borrowValue(explicitSeed.value);
    this.#attachTensorControls(seed, [result.value.outcomes, explicitSeed?.value.outcomes ?? []]);
    try {
      const gradients = this.#history.execute(plan, seed, this.#derivativeOperations(),
        effects === 0 && this.#writers.references === 0 ? undefined
          : (node, incoming, traversed) => this.#receiveGradient(node, incoming, traversed, destinations));
      for (const gradient of gradients) {
        this.#attachTensorControls(gradient, [outcomes]);
      }
      return gradients;
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

  #assignGradient(owner: TensorState, handle: unknown): void {
    let assigned: TensorIdentity | null = null;
    if (handle !== null) {
      const state = this.#gradientInput(handle);
      if (state.identity === owner.identity) throw new TabgradError("INVALID_GRADIENT", "A tensor cannot be its own gradient.");
      if (!equalTensorShapes(owner.shape, state.shape)) throw new TabgradError("SHAPE_MISMATCH", "Assigned gradient must match its owner's shape.");
      assigned = state.identity;
    }
    if (assigned !== null && assigned !== owner.identity.gradient) this.#checkUpdateCapacity(1);
    this.#replaceGradient(owner.identity, assigned);
  }

  #replaceGradient(owner: TensorIdentity, assigned: TensorIdentity | null): void {
    const previous = owner.gradient;
    if (previous === assigned) return;
    if (assigned !== null) { this.#retainIdentity(assigned); this.#associationOwners += 1; }
    owner.gradient = assigned;
    if (previous !== null) {
      this.#associationOwners -= 1;
      try { this.#releaseIdentity(previous); }
      finally { this.#scheduleCollection(); }
    }
  }

  #moveRetention(identity: TensorIdentity, previous: DerivativeNode<TensorValue> | null,
    next: DerivativeNode<TensorValue> | null): void {
    if (!identity.retained || previous === next) return;
    if (previous !== null) this.#retainedEntries.delete(previous);
    if (next !== null) this.#retainedEntries.set(next, new WeakRef(identity));
  }

  #backward(result: TensorState, seedHandle: unknown, options: unknown): void {
    withTensorFinalizerScope(() => this.#backwardImpl(result, seedHandle, options));
  }

  #backwardImpl(result: TensorState, seedHandle: unknown, options: unknown): void {
    assertTensorOpen(result);
    this.#requireGradients(this.#backendFor(result.value.device, "backward"), "backward");
    if (options !== undefined && (options === null || typeof options !== "object" || Array.isArray(options))) {
      throw new TypeError("backward options must be an object.");
    }
    const selected = options as BackwardOptions | undefined;
    if (selected !== undefined) {
      for (const key of Object.keys(selected)) {
        if (!["inputs", "retainGraph", "createGraph"].includes(key)) throw new TypeError("Unknown backward option.");
      }
      for (const mode of [selected.retainGraph, selected.createGraph]) {
        if (mode !== undefined && typeof mode !== "boolean") throw new TypeError("Backward mode options must be booleans.");
        if (mode === true) throw new TabgradError("UNSUPPORTED_GRADIENT", "Retained and higher-order backward are unsupported.");
      }
      if (selected.inputs !== undefined && (!Array.isArray(selected.inputs) || selected.inputs.length === 0)) {
        throw new TypeError("backward inputs must be a nonempty array.");
      }
    }
    const explicitSeed = seedHandle === undefined ? undefined : this.#gradientInput(seedHandle);
    if (explicitSeed !== undefined && !equalTensorShapes(result.shape, explicitSeed.shape)) {
      throw new TabgradError("SHAPE_MISMATCH", "Gradient seed must match output shape.");
    }
    if (explicitSeed === undefined && tensorElementCount(result.shape) !== 1) {
      throw new TabgradError("INVALID_GRADIENT", "An implicit gradient requires an output with exactly one element.");
    }
    const output = result.history;
    if (output === null) throw new TabgradError("GRADIENT_NOT_TRACKED", "Output must require gradients and have derivative history.");
    const requested: TensorIdentity[] = [];
    if (selected?.inputs !== undefined) {
      for (const handle of selected.inputs) {
        const state = this.#gradientInput(handle);
        if (!state.requiresGrad) throw new TabgradError("GRADIENT_NOT_TRACKED", "Requested input must require gradients.");
        const entry = state.history;
        if (!state.identity.trueLeaf && entry !== null) {
          state.identity.retained = true;
          this.#retainedEntries.set(entry, new WeakRef(state.identity));
        }
        if (!requested.includes(state.identity)) requested.push(state.identity);
      }
    }
    if (selected?.inputs === undefined) {
      const seen = new Set<DerivativeNode<TensorValue>>();
      const pending = [output];
      while (pending.length !== 0) {
        const node = pending.pop()!;
        if (seen.has(node)) continue;
        seen.add(node);
        if (node.leafOwner instanceof TensorIdentity) requested.push(node.leafOwner);
        for (const input of node.inputs) if (input !== null) pending.push(input);
      }
    }
    const plan = this.#history.plan(output, requested.map(identity => identity.entry).filter(entry => entry !== null), true);
    if (plan.order.length === 0) return;
    if (this.#mutationFailure !== undefined) {
      throw new TabgradError("MUTATION_FAILED", "A failed write prevents further updates in this session.", {}, this.#mutationFailure.error);
    }
    const destinations = new Set(requested);
    const effects = this.#reserveGradientEffects(plan.order, destinations);
    const controls = captureWriterOutcomes([result.value.outcomes, explicitSeed?.value.outcomes ?? []]).length
      + this.#gradientControlBound(plan.order, destinations, effects);
    const additionalBytes = (explicitSeed === undefined ? 4 : 0)
      + plan.order.reduce((bytes, node) => bytes + tensorElementCount(node.shape) * 20, 0);
    this.#checkUpdateCapacity((plan.order.length * 20 + requested.length * 10 + 10) * (controls + 1), additionalBytes);
    const seed = explicitSeed === undefined ? this.tensor([1], { shape: result.shape }) : this.#borrowValue(explicitSeed.value);
    if (explicitSeed !== undefined) {
      const identity = requireTensorState(seed).identity;
      this.#bindIncomingIdentity(identity, explicitSeed.identity);
      identity.acquisitionFamily = explicitSeed.family;
    }
    this.#attachTensorControls(seed, [result.value.outcomes, explicitSeed?.value.outcomes ?? []]);
    try {
      const returned = this.#history.execute(plan, seed, this.#derivativeOperations(),
        (node, incoming, traversed) => this.#receiveGradient(node, incoming, traversed, destinations), true, false);
      for (const handle of returned) handle.close();
    } finally { seed.close(); }
  }

  #reserveGradientEffects(nodes: readonly DerivativeNode<TensorValue>[], destinations: ReadonlySet<TensorIdentity>): number {
    let effects = 0;
    for (const node of nodes) if (this.#gradientReceiver(node, destinations) !== undefined) effects += 1;
    if (this.#pendingCopies + effects > this.#updateLimits.pendingCopies) {
      throw new TabgradError("RESOURCE_EXHAUSTED", "Differentiation exceeds pending-effect capacity.");
    }
    return effects;
  }

  #gradientControlBound(nodes: readonly DerivativeNode<TensorValue>[], destinations: ReadonlySet<TensorIdentity>, effects: number): number {
    // Live plan/gradient captures retain ledger references. Without any such
    // captures, only the newly planned writers contribute to this bound.
    if (this.#writers.references === 0) return effects;
    // Include existing node/prior-gradient controls and one new writer per
    // destination. Each recipe admits at most two contributions plus combines;
    // twenty owner slots per node bound their captures at the transient peak.
    const groups = nodes.flatMap(node => [node.outcomes, this.#gradientReceiver(node, destinations)?.gradient?.value.outcomes ?? []]);
    return captureWriterOutcomes(groups).length + effects;
  }

  #receiveGradient(node: DerivativeNode<TensorValue>, incoming: Tensor, traversed: boolean,
    destinations: ReadonlySet<TensorIdentity>): void {
    if (traversed) this.#attachTensorControls(incoming, [node.outcomes]);
    const owner = this.#gradientReceiver(node, destinations);
    if (owner !== undefined && !owner.retired) this.#accumulateGradient(owner, incoming,
      owner.trueLeaf && this.#canAcquireIncoming(requireTensorState(incoming).identity));
  }

  #gradientReceiver(node: DerivativeNode<TensorValue>, destinations: ReadonlySet<TensorIdentity>): TensorIdentity | undefined {
    return node.leafOwner instanceof TensorIdentity && destinations.has(node.leafOwner)
      ? node.leafOwner.requiresGrad ? node.leafOwner : undefined : this.#retainedEntries.get(node)?.deref();
  }

  #detachedAlias(source: TensorIdentity, acquire = false): Tensor {
    const family = acquire ? source.acquisitionFamily ?? source.family : source.family;
    family.identities += 1;
    const identity = new TensorIdentity(family, source.value, null, false, null, false, false);
    if (acquire) this.#setIdentityControls(identity, source.value.outcomes);
    this.#identities.add(identity);
    return this.#expose(identity);
  }

  #derivativeOperations() {
    return {
      borrow: (value: TensorValue) => this.#borrowValue(value),
      add: (left: Tensor, right: Tensor) => this.#combineIncoming(left, right),
      mul: (left: Tensor, right: Tensor) => this.noGrad(() => left.mul(right)),
      view: (value: Tensor, shape: readonly number[]) => this.noGrad(() => value.view(shape)),
      pass: (value: Tensor, _shape: readonly number[]) => {
        const source = requireTensorState(value).identity;
        const result = this.#detachedAlias(source);
        const identity = requireTensorState(result).identity;
        this.#bindIncomingIdentity(identity, source);
        identity.incomingDense = source.incomingDense;
        identity.acquisitionFamily = source.acquisitionFamily;
        return result;
      },
      expand: (value: Tensor, shape: readonly number[]) => this.#expand(value, shape),
      zeros: (shape: readonly number[]) => this.tensor(new Float32Array(tensorElementCount(shape)), { shape }),
      close: (value: Tensor) => value.close(),
      inherit: (value: Tensor, source: Tensor) => this.#attachTensorControls(value, [requireTensorState(source).value.outcomes]),
    };
  }

  #bindIncomingIdentity(identity: TensorIdentity, source: TensorIdentity): void {
    identity.incomingIdentity.owners -= identity.references;
    identity.incomingIdentity = source.incomingIdentity;
    identity.incomingIdentity.owners += identity.references;
  }

  #canAcquireIncoming(identity: TensorIdentity): boolean {
    return identity.incomingDense && identity.incomingIdentity.owners === 1;
  }

  #combineIncoming(left: Tensor, right: Tensor): Tensor {
    const source = requireTensorState(left).identity;
    const reusable = this.#canAcquireIncoming(source) && source.family.identities === 1;
    const result = this.noGrad(() => left.add(right));
    if (reusable) {
      const identity = requireTensorState(result).identity;
      identity.family.version = source.family.version + 1;
      identity.family.current.version = identity.family.version;
    }
    return result;
  }

  #attachTensorControls(handle: Tensor, groups: readonly (readonly WriterOutcome[])[]): void {
    const identity = requireTensorState(handle).identity;
    if (identity.controls.length === 0 && groups.every(group => group.length === 0)) return;
    this.#setIdentityControls(identity, captureWriterOutcomes([identity.controls, ...groups]));
  }

  #setIdentityControls(identity: TensorIdentity, controls: readonly WriterOutcome[]): void {
    if (identity.controls.length === 0 && controls.length === 0) return;
    const next = captureWriterOutcomes([controls]);
    retainWriterOutcomes(next);
    releaseWriterOutcomes(identity.controls);
    identity.controls = next;
  }

  #accumulateGradient(owner: TensorIdentity, incoming: Tensor, share: boolean): void {
    if (this.#mutationFailure !== undefined) {
      throw new TabgradError("MUTATION_FAILED", "A failed write prevents further updates in this session.", {}, this.#mutationFailure.error);
    }
    let acquired: Tensor;
    const prior = owner.gradient;
    if (prior !== null && owner.trueLeaf) {
      const state = new TensorState(this, prior, (state) => this.#resolveHistory(state));
      const next = this.noGrad(() => this.#binary(ADD_OPERATION, state, incoming));
      try { this.noGrad(() => this.#copy(state, next)); }
      finally { next.close(); }
      return;
    }
    if (prior !== null) {
      const state = new TensorState(this, prior, (state) => this.#resolveHistory(state));
      acquired = this.noGrad(() => this.#binary(ADD_OPERATION, state, incoming));
    } else if (share) {
      acquired = this.#detachedAlias(requireTensorState(incoming).identity, true);
    } else {
      acquired = this.#borrowValue(requireTensorState(incoming).value);
      // Leaf detached-clone acquisition starts at one; retained nonleaf
      // cloning starts at zero. Captured metadata must match its new counter.
      const version = owner.trueLeaf ? 1 : 0;
      requireTensorState(acquired).family.version = version;
      requireTensorState(acquired).family.current.version = version;
    }
    try {
      // Acquisition is mandatory too: clearing the slot cannot cancel it.
      const source = requireTensorState(acquired).value;
      const prerequisites = captureWriterOutcomes([source.outcomes]);
      const outcome = this.#writers.create();
      this.#retainValue(source);
      retainWriterOutcomes(prerequisites);
      this.#setIdentityControls(requireTensorState(acquired).identity,
        captureWriterOutcomes([requireTensorState(acquired).identity.controls, [outcome]]));
      this.#pendingCopies += 1;
      this.#enqueue(this.#copyEffect(source, prerequisites, outcome), () => {
        this.#pendingCopies -= 1;
        if (this.#pendingCopies === 0) { this.#copyCompletion?.resolve(); this.#copyCompletion = undefined; }
        let failures: unknown[] | undefined;
        try { this.#releaseValue(source); } catch (error) { (failures ??= []).push(error); }
        try { releaseWriterOutcomes(prerequisites); } catch (error) { (failures ??= []).push(error); }
        throwCleanupFailures(failures, "Gradient acquisition retirement failed.");
      }, () => this.#replaceGradient(owner, requireTensorState(acquired).identity));
    } finally { acquired.close(); }
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

  #resolveHistory(state: TensorState): DerivativeNode<TensorValue> | null {
    if (!state.isView) return state.identity.requiresGrad ? state.identity.entry : null;
    if (state.specialView && state.requiresGrad && state.historyVersion !== state.family.version) {
      throw new TabgradError("INPLACE_VIEW", "A view created in no_grad was modified in place, or its base was modified while recording.");
    }
    // Creation provenance survives an active child view and is independent
    // of its bound derivative entry. Keep the original epoch even while plain.
    if (state.specialView) return state.viewHistory;
    if (state.historyVersion === state.family.version) return state.viewHistory;
    const previous = state.viewHistory;
    state.viewHistory = state.requiresGrad
      ? this.#history.record(state.shape, IDENTITY_DERIVATIVE, [this.#familyBase(state.identity).entry], [state.value])
      : null;
    state.historyVersion = state.family.version;
    this.#moveRetention(state.identity, previous, state.viewHistory);
    if (previous !== null) this.#history.release(previous);
    return state.viewHistory;
  }

  #validateSavedValue(value: TensorValue): void {
    if (value.detachmentCounter !== null && value.detachmentCounter.value !== value.detachmentVersion) {
      throw new TabgradError("SAVED_DETACHED", "A saved tensor was detached in place.");
    }
    if (value.versionCounter !== null && value.versionCounter.value !== value.version) {
      throw new TabgradError("SAVED_VERSION_MISMATCH", "A tensor saved for differentiation was modified in place.", {
        expectedVersion: value.version, actualVersion: value.versionCounter!.value,
      });
    }
  }

  #borrowValue(value: TensorValue): Tensor {
    const captured = new TensorValue(value, null, value.storage);
    captured.storage.references += 1;
    captured.outcomes = captureWriterOutcomes([value.outcomes]);
    retainWriterOutcomes(captured.outcomes);
    this.#values.add(captured);
    this.#valueReferences += 1;
    return this.#createHandle(captured);
  }

  #copy(destination: TensorState, sourceHandle: unknown): void {
    assertTensorOpen(destination);
    const source = requireTensorState(sourceHandle);
    assertTensorOpen(source);
    if (source.session !== this) throw new TabgradError("DIFFERENT_SESSION", "Copy tensors must belong to this session.");
    if (destination.value.device !== "cpu" || source.value.device !== "cpu") {
      throw new TabgradError("UNSUPPORTED_DEVICE", "Persistent copy requires CPU tensors.");
    }
    if (this.#recording && destination.specialView && (destination.requiresGrad || source.requiresGrad)) {
      throw new TabgradError("INPLACE_VIEW", "A view created in no_grad cannot be updated while recording gradients.");
    }
    if (this.#recording && destination.requiresGrad && this.#familyBase(destination.identity).entry?.recipe === null) {
      throw new TabgradError("INPLACE_GRADIENT", "A leaf requiring gradients, or its view, cannot be updated while recording.");
    }
    if (this.#mutationFailure !== undefined) {
      throw new TabgradError("MUTATION_FAILED", "A failed write prevents further updates in this session.", {}, this.#mutationFailure.error);
    }
    if (!equalTensorShapes(destination.shape, source.shape)) {
      throw new TabgradError("SHAPE_MISMATCH", "Copy requires equal tensor shapes.");
    }
    const previous = destination.family.current;
    const captured = source.value;
    const prerequisites = captureWriterOutcomes([previous.outcomes, destination.identity.controls, captured.outcomes]);
    this.#checkUpdateCapacity(9 + prerequisites.length * 2);
    if (this.#pendingCopies >= this.#updateLimits.pendingCopies || destination.family.version >= Number.MAX_SAFE_INTEGER) {
      throw new TabgradError("RESOURCE_EXHAUSTED", "Persistent copy admission exceeds its pending-count or version capacity.");
    }
    const outcome = this.#writers.create();
    const base = this.#familyBase(destination.identity);
    const previousHistory = base.entry;
    const history = this.#recording && (destination.requiresGrad || source.requiresGrad)
      ? this.#history.record(previous.shape, destination.isView ? COPY_SLICES_DERIVATIVE : COPY_DERIVATIVE, [previousHistory, source.history], [previous, captured], [outcome])
      : previousHistory;
    const next = new TensorValue({ ...previous, shape: previous.shape }, null, captured.storage);
    next.storage.references += 1;
    next.versionCounter = destination.family.versionCounter;
    next.version = destination.family.version + 1;
    next.detachmentCounter = destination.identity.detachmentCounter;
    next.detachmentVersion = destination.identity.detachmentCounter.value;
    next.outcomes = [outcome];
    retainWriterOutcomes(next.outcomes);
    this.#retainValue(captured);
    retainWriterOutcomes(prerequisites);
    this.#values.add(next);
    this.#valueReferences += 1;
    this.#pendingCopies += 1;
    if (history !== previousHistory) {
      base.entry = history;
      base.requiresGrad = destination.requiresGrad || source.requiresGrad;
      this.#moveRetention(base, previousHistory, history);
    }
    destination.family.current = next;
    destination.family.version = next.version;
    this.#setIdentityControls(destination.identity, []);
    if (destination.isView && this.#recording) this.#resolveHistory(destination);
    this.#enqueue(this.#copyEffect(captured, prerequisites, outcome), () => {
      this.#pendingCopies -= 1;
      if (this.#pendingCopies === 0) {
        this.#copyCompletion?.resolve();
        this.#copyCompletion = undefined;
      }
      let failures: unknown[] | undefined;
      try { this.#releaseValue(captured); } catch (error) { (failures ??= []).push(error); }
      try { releaseWriterOutcomes(prerequisites); } catch (error) { (failures ??= []).push(error); }
      throwCleanupFailures(failures, "Copy effect retirement failed.");
    });
    let failures: unknown[] | undefined;
    if (history !== previousHistory && previousHistory !== null) {
      try { this.#history.release(previousHistory); } catch (error) { (failures ??= []).push(error); }
    }
    try { this.#releaseValue(previous); } catch (error) { (failures ??= []).push(error); }
    throwCleanupFailures(failures, "Committed copy predecessor retirement failed.");
  }

  #checkUpdateCapacity(additionalOwners: number, additionalBytes = 0): void {
    const owners = this.#identityReferences + this.#valueReferences + this.#history.references + this.#writers.references
      + this.#requestLeases + this.#undeliveredEffects.size + this.#optimizers.size;
    if (owners + additionalOwners > this.#updateLimits.owners || this.#liveBackingBytes + additionalBytes > this.#updateLimits.backingBytes) {
      throw new TabgradError("RESOURCE_EXHAUSTED", "Persistent update captures exceed the session capacity.", {
        owners, additionalOwners, maximumOwners: this.#updateLimits.owners,
        backingBytes: this.#liveBackingBytes, additionalBytes, maximumBackingBytes: this.#updateLimits.backingBytes,
      });
    }
  }

  *#copyEffect(source: TensorValue, prerequisites: readonly WriterOutcome[], outcome: WriterOutcome): Generator<ExecutionStep, void, unknown> {
    const priorFailure = failedWriterOutcome(prerequisites) ?? this.#mutationFailure;
    if (priorFailure !== undefined) {
      outcome.state = { kind: "failure", failure: priorFailure };
      return;
    }
    try {
      const formed = this.#formProgram(source);
      const backend = this.#backendFor(source.device, "copy_");
      if (this.#materializations.get(source)?.kind !== "host") {
        yield* this.#prepareBackend(backend, formed.program);
        yield* this.#materialize(source, formed, backend);
      }
      backend.assertAvailable();
      this.#beforeCopyPublication?.();
      outcome.state = { kind: "success" };
    } catch (error) {
      const failure: EffectFailure = { error, delivered: false };
      outcome.state = { kind: "failure", failure };
      this.#undeliveredEffects.add(failure);
      this.#mutationFailure ??= failure;
    }
  }

  #deliverFailure(failure: EffectFailure): void {
    failure.delivered = true;
    this.#undeliveredEffects.delete(failure);
  }

  async #complete(): Promise<void> {
    // Managed entry must join its mandatory CPU effects, while an unrelated
    // failed GPU observation may still own a separately supervised drain lease.
    if (this.#pendingCopies !== 0) {
      if (this.#copyCompletion === undefined) {
        let resolve!: () => void;
        const promise = new Promise<void>((completed) => { resolve = completed; });
        this.#copyCompletion = { promise, resolve };
      }
      await this.#copyCompletion.promise;
    }
    const failures = [...this.#undeliveredEffects];
    for (const failure of failures) this.#deliverFailure(failure);
    throwCleanupFailures(failures.map((failure) => failure.error), "Runtime effects failed.");
  }

  #checkCapturedAdmission(values: readonly TensorValue[], shape?: readonly number[], extraOwners = 0): void {
    if (this.#writers.references === 0) return;
    const outcomes = captureWriterOutcomes(values.map(value => value.outcomes));
    if (outcomes.length !== 0) {
      this.#checkUpdateCapacity((values.length * 10 + extraOwners + 2) * (outcomes.length + 1),
        shape === undefined ? 0 : tensorElementCount(shape) * 4);
    }
  }

  #sum(source: TensorState): Tensor {
    assertTensorOpen(source);
    this.#requireComputation(source.value, SUM_OPERATION);
    const admitted = SUM_OPERATION.admit(source);
    this.#checkCapturedAdmission(admitted.record.inputs, admitted.outputMetadata.shape);
    const history = !this.#recording || !source.requiresGrad ? null
      : this.#history.record(admitted.outputMetadata.shape, SUM_OPERATION.derivative, [source.history], admitted.record.inputs);
    return this.#recordOperation(admitted, history);
  }

  #expand(source: Tensor, shape: readonly number[]): Tensor {
    const value = requireTensorState(source).value;
    if (tensorElementCount(value.shape) !== 1) {
      throw new TabgradError("INVALID_GRADIENT", "Scalar expansion requires a one-element input.");
    }
    this.#checkCapturedAdmission([value], shape);
    const result = this.#recordOperation({
      record: new OperationRecord(EXPAND_OPERATION, [value]),
      outputMetadata: { shape, dtype: value.dtype, device: value.device, layout: value.layout },
    });
    requireTensorState(result).identity.incomingDense = false;
    return result;
  }

  #binary(definition: EqualShapeBinaryOperationDefinition, left: TensorState, rightHandle: unknown): Tensor {
    this.#assertOpen();
    const admitted = definition.admit(this, left, rightHandle);
    this.#requireComputation(admitted.record.inputs[0]!, definition);
    const right = requireTensorState(rightHandle);
    this.#checkCapturedAdmission(admitted.record.inputs, admitted.outputMetadata.shape);
    const history = !this.#recording || (!left.requiresGrad && !right.requiresGrad) ? null
      : this.#history.record(admitted.outputMetadata.shape, definition.derivative,
        [left.history, right.history], admitted.record.inputs);
    return this.#recordOperation(admitted, history);
  }

  #recordOperation(admitted: AdmittedOperation, history: DerivativeNode<TensorValue> | null = null): Tensor {
    for (const input of admitted.record.inputs) {
      this.#retainValue(input);
    }
    const result = new TensorValue(admitted.outputMetadata, admitted.record);
    result.outcomes = captureWriterOutcomes(admitted.record.inputs.map((input) => input.outcomes));
    this.#registerValue(result);
    return this.#createHandle(result, history);
  }

  #view(source: TensorState, shape: unknown): Tensor {
    const metadata = VIEW_OPERATION.admit(source, shape);
    this.#backendFor(source.value.device, "view");
    const captured = source.value;
    this.#checkCapturedAdmission([captured], undefined, 4);
    const value = new TensorValue(metadata, null, captured.storage);
    value.references = 0;
    value.versionCounter = source.family.versionCounter;
    value.version = source.family.version;
    value.outcomes = captured.outcomes;
    const requiresGrad = source.requiresGrad;
    const history = !this.#recording || !requiresGrad ? null
      : this.#history.record(value.shape, VIEW_OPERATION.derivative, [source.history], [captured]);
    source.family.identities += 1;
    this.#retainIdentity(source.identity);
    const identity = new TensorIdentity(source.family, value, history, requiresGrad,
      source.identity, !this.#recording || source.specialView, false);
    this.#setIdentityControls(identity, source.identity.controls);
    identity.incomingDense = source.identity.incomingDense;
    identity.acquisitionFamily = source.identity.acquisitionFamily;
    this.#identities.add(identity);
    return this.#expose(identity);
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
    const captured = state.value;
    this.#checkCapturedAdmission([captured]);
    this.#retainValue(captured);
    return this.#enqueue(this.#observation(captured), () => this.#releaseValue(captured)).asPromise();
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
    const captured = state.value;
    this.#checkCapturedAdmission([captured]);
    this.#retainValue(captured);
    return this.#enqueue(this.#observation(captured), () => this.#releaseValue(captured)).read();
  }

  *#observation(value: TensorValue): Generator<ExecutionStep, Float32Array, unknown> {
    const formed = this.#formProgram(value);
    try {
      const writerFailure = failedWriterOutcome(value.outcomes);
      if (writerFailure !== undefined) {
        this.#deliverFailure(writerFailure);
        throw writerFailure.error;
      }
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

  #semanticOwnership(): RuntimeSemanticOwnership {
    this.#collectCycles();
    const identities = [...this.#identities];
    const identityReferences = identities.reduce((total, identity) => total + identity.references, 0);
    const gradientAssociations = identities.filter(identity => identity.gradient !== null).length;
    const viewBaseReferences = identities.filter(identity => identity.base !== null).length;
    const leafEndpointOwners = this.#history.leafOwners;
    const nonleafEntryOwners = identities.filter(identity => !identity.trueLeaf && identity.entry !== null).length;
    const publicExposures = this.#states.size;
    const incoming = new Set(identities.map(identity => identity.incomingIdentity));
    const incomingReferences = [...incoming].reduce((total, token) => total + token.owners, 0);
    if (identityReferences !== this.#identityReferences || incomingReferences !== identityReferences ||
      gradientAssociations !== this.#associationOwners ||
      identityReferences !== publicExposures + gradientAssociations + viewBaseReferences + leafEndpointOwners + this.#optimizerOccurrences) {
      throw new TabgradError("BACKEND_STATUS_ERROR", "Semantic ownership and its occurrence accounting disagree.");
    }
    return { identities: identities.length, identityReferences, gradientAssociations, viewBaseReferences,
      leafEndpointOwners, nonleafEntryOwners, publicExposures, optimizerOccurrences: this.#optimizerOccurrences,
      optimizerRegistrations: this.#optimizers.size,
      collectorPasses: this.#collectorPasses, collectorVisitedIdentities: this.#collectorVisitedIdentities,
      collectorVisitedHistoryNodes: this.#collectorVisitedHistoryNodes, collectorVisitedEdges: this.#collectorVisitedEdges };
  }

  #ownership(): RuntimeOwnership {
    this.#collectCycles();
    const families = new Set([...this.#identities].map((identity) => identity.family));
    const backings = new Set([...this.#values].map((value) => value.storage));
    const valueReferences = [...this.#values].reduce((total, value) => total + value.references, 0);
    const backingBytes = [...backings].reduce((total, backing) => total + tensorElementCount(backing.value.shape) * 4, 0);
    const controlReferences = [...this.#writers.live].reduce((total, outcome) => total + outcome.references, 0);
    if (valueReferences !== this.#valueReferences || backingBytes !== this.#liveBackingBytes || controlReferences !== this.#writers.references) {
      throw new TabgradError("BACKEND_STATUS_ERROR", "Live ownership and its admission accounting disagree.");
    }
    return { families: families.size, backings: backings.size, backingBytes, valueReferences,
      derivativeReferences: this.#history.references, writerOutcomes: this.#writers.live.size,
      controlReferences, pendingCopies: this.#pendingCopies, undeliveredEffects: this.#undeliveredEffects.size };
  }

  diagnostics(): RuntimeDiagnostics {
    this.#collectCycles();
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
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    // Install the join before invoking fallible or reentrant backend cleanup.
    this.#closePromise = new Promise<void>((onClosed, onFailure) => {
      resolve = onClosed;
      reject = onFailure;
    });
    const failures = this.#cleanupFailures ??= [];
    for (const optimizer of [...this.#optimizers]) {
      try { this.#retireOptimizer(optimizer); }
      catch (error) { failures.push(error); }
    }
    for (const state of [...this.#states]) {
      if (!state.closed) {
        state.closed = true;
        unregisterTensorFinalizer(state);
        try { this.#releaseHandle(state); }
        catch (error) { failures.push(error); }
      }
    }
    try { this.#collectCycles(); }
    catch (error) { failures.push(error); }
    void this.#finishClose(failures).then(resolve, reject);
    return this.#closePromise;
  }

  async #finishClose(failures: unknown[]): Promise<void> {
    await this.#drainRequests();
    for (const failure of this.#undeliveredEffects) { failures.push(failure.error); failure.delivered = true; }
    this.#undeliveredEffects.clear();
    for (const materialization of this.#materializations.values()) {
      if (materialization.kind === "resident") {
        try { materialization.backend.release(materialization.allocation); }
        catch (error) { failures.push(error); }
      }
    }
    this.#materializations.clear();
    try { await this.#backend.close(); }
    catch (error) { failures.push(error); }
    try { await this.#gpuBackend?.close(); }
    catch (error) { failures.push(error); }
    throwCleanupFailures(failures, "Runtime session cleanup failed.");
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new TabgradError("CLOSED_SESSION", "The runtime session is closed.");
    }
  }

  #releaseHandle(state: TensorState): void {
    this.#states.delete(state);
    state.identity.exposures -= 1;
    try { this.#releaseIdentity(state.identity); }
    finally { this.#scheduleCollection(); }
  }

  #createHandle(value: TensorValue, history: DerivativeNode<TensorValue> | null = null,
    requiresGrad: boolean = history !== null): Tensor {
    const identity = new TensorIdentity(new TensorFamily(value), value, history, requiresGrad,
      null, false, requiresGrad && history === null);
    value.detachmentCounter = identity.detachmentCounter;
    this.#identities.add(identity);
    return this.#expose(identity);
  }

  #expose(identity: TensorIdentity): Tensor {
    const existing = identity.canonical?.deref();
    if (existing !== undefined && !requireTensorState(existing).closed) return existing;
    const state = new TensorState(this, identity, (state) => this.#resolveHistory(state));
    this.#retainIdentity(identity);
    identity.exposures += 1;
    this.#states.add(state);
    const handle = createTensorHandle(state);
    identity.canonical = new WeakRef(handle);
    return handle;
  }

  #familyBase(identity: TensorIdentity): TensorIdentity {
    while (identity.base !== null) identity = identity.base;
    return identity;
  }

  #releaseIdentity(identity: TensorIdentity): void {
    if (identity.retired) return;
    identity.references -= 1;
    identity.incomingIdentity.owners -= 1;
    this.#identityReferences -= 1;
    if (identity.references < 0) throw new TabgradError("BACKEND_STATUS_ERROR", "A semantic tensor owner was released twice.");
    if (identity.references !== 0) return;
    this.#retirementQueue.push(identity);
    if (this.#retiring) return;
    this.#retiring = true;
    let failures: unknown[] | undefined;
    try {
      let current: TensorIdentity | TensorValue | undefined;
      while ((current = this.#retirementQueue.pop()) !== undefined) {
        if (current instanceof TensorValue) {
          try { this.#releaseValue(current); } catch (error) { (failures ??= []).push(error); }
          continue;
        }
        if (current.retired) continue;
        const pendingOffset = this.#retirementQueue.length;
        current.retired = true;
        this.#identities.delete(current);
        const gradient = current.gradient;
        current.gradient = null;
        if (gradient !== null) {
          this.#associationOwners -= 1;
          try { this.#releaseIdentity(gradient); } catch (error) { (failures ??= []).push(error); }
        }
        if (current.base !== null) {
          try { this.#releaseIdentity(current.base); } catch (error) { (failures ??= []).push(error); }
        }
        if (current.entry !== null && !current.trueLeaf) {
          this.#retainedEntries.delete(current.entry);
          try { this.#history.release(current.entry); } catch (error) { (failures ??= []).push(error); }
        }
        current.entry = null;
        releaseWriterOutcomes(current.controls);
        current.controls = [];
        current.family.identities -= 1;
        // Retire children in the order their owning releases were scheduled,
        // before this identity's final numerical pin. Keep constant stack depth.
        const children = this.#retirementQueue.splice(pendingOffset);
        if (current.family.identities === 0) {
          this.#retirementQueue.push(current.family.current);
        }
        for (let index = children.length - 1; index >= 0; index -= 1) this.#retirementQueue.push(children[index]!);
      }
    } finally { this.#retiring = false; }
    throwCleanupFailures(failures, "Semantic tensor retirement failed.");
  }

  #retainIdentity(identity: TensorIdentity): void {
    identity.references += 1;
    identity.incomingIdentity.owners += 1;
    this.#identityReferences += 1;
  }

  #scheduleCollection(): void {
    if (this.#associationOwners === 0 || this.#collectionScheduled) return;
    this.#collectionScheduled = true;
    queueMicrotask(() => {
      try { this.#collectCycles(); }
      catch (error) { (this.#cleanupFailures ??= []).push(error); }
    });
  }

  /** Mark actual semantic roots; retire logical owners before fallible payload cleanup. */
  #collectCycles(): void {
    if (!this.#collectionScheduled && !this.#closed) return;
    this.#collectionScheduled = false;
    this.#collectorPasses += 1;
    const live = new Set<TensorIdentity>();
    const histories = new Set<DerivativeNode<TensorValue>>();
    const pending: (TensorIdentity | DerivativeNode<TensorValue>)[] = [...this.#states].map(state => state.identity);
    for (const optimizer of this.#optimizers) for (const group of optimizer.groups) {
      for (const state of group) pending.push(state.identity);
    }
    while (pending.length !== 0) {
      const owner = pending.pop()!;
      if (owner instanceof TensorIdentity) {
        if (live.has(owner) || owner.retired) continue;
        live.add(owner);
        this.#collectorVisitedIdentities += 1;
        if (owner.gradient !== null) { pending.push(owner.gradient); this.#collectorVisitedEdges += 1; }
        if (owner.base !== null) { pending.push(owner.base); this.#collectorVisitedEdges += 1; }
        if (!owner.trueLeaf && owner.entry !== null) { pending.push(owner.entry); this.#collectorVisitedEdges += 1; }
      } else {
        if (histories.has(owner)) continue;
        histories.add(owner);
        this.#collectorVisitedHistoryNodes += 1;
        if (owner.leafOwner instanceof TensorIdentity) { pending.push(owner.leafOwner); this.#collectorVisitedEdges += 1; }
        for (const input of owner.inputs) if (input !== null) { pending.push(input); this.#collectorVisitedEdges += 1; }
      }
    }
    const unreachable = [...this.#identities].filter(identity => !live.has(identity));
    // Break every association occurrence first. Other releases use ordinary
    // reference ownership; requests continue owning their captured values.
    const released: TensorIdentity[] = [];
    for (const identity of unreachable) {
      if (identity.gradient !== null) {
        released.push(identity.gradient);
        identity.gradient = null;
        this.#associationOwners -= 1;
      }
    }
    let failures: unknown[] | undefined;
    for (const identity of released) {
      try { this.#releaseIdentity(identity); } catch (error) { (failures ??= []).push(error); }
    }
    throwCleanupFailures(failures, "Semantic cycle retirement failed.");
  }

  #registerValue(value: TensorValue): void {
    this.#values.add(value);
    this.#valueReferences += 1;
    if (value.storage.value === value && value.storage.references === 1) {
      this.#liveBackingBytes += tensorElementCount(value.shape) * 4;
    }
    retainWriterOutcomes(value.outcomes);
    if (value.producer !== null) {
      this.#operationRecords += 1;
    }
  }

  #retainValue(value: TensorValue): void {
    if (value.references === 0) { this.#values.add(value); retainWriterOutcomes(value.outcomes); }
    value.references += 1;
    this.#valueReferences += 1;
    value.storage.references += 1;
  }

  #releaseValue(value: TensorValue): void {
    // Entries represent owning references, not distinct values: repeated
    // input positions must each be released, even when they share a value.
    const pending = [value];
    let failures: unknown[] | undefined;
    while (pending.length > 0) {
      const current = pending.pop()!;
      current.references -= 1;
      this.#valueReferences -= 1;
      current.storage.references -= 1;
      if (current.references < 0) {
        throw new TabgradError(
          "BACKEND_STATUS_ERROR",
          "A tensor value was released more times than it was retained.",
        );
      }
      if (current.references === 0) { this.#values.delete(current); releaseWriterOutcomes(current.outcomes); }
      if (current.storage.references > 0) continue;
      this.#liveBackingBytes -= tensorElementCount(current.storage.value.shape) * 4;
      const materialization = this.#materializations.delete(current);
      if (materialization?.kind === "resident") {
        try { materialization.backend.release(materialization.allocation); }
        catch (error) { (failures ??= []).push(error); }
      }
      const producer = this.#detachProducer(current);
      if (producer !== null) {
        // Reverse insertion preserves depth-first, left-to-right release.
        for (let index = producer.inputs.length - 1; index >= 0; index -= 1) {
          pending.push(producer.inputs[index]!);
        }
      }
    }
    throwCleanupFailures(failures, "Tensor value cleanup failed.");
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
    let failures: unknown[] | undefined;
    for (const input of producer.inputs) {
      try { this.#releaseValue(input); }
      catch (error) { (failures ??= []).push(error); }
    }
    throwCleanupFailures(failures, "Completed tensor dependency cleanup failed.");
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
      this.#releaseCompletedDependencies(formed.newlyComputed);
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

  #releaseCompletedDependencies(values: readonly TensorValue[]): void {
    let failures: unknown[] | undefined;
    for (const value of values) {
      try { this.#releaseDependencies(value); }
      catch (error) { (failures ??= []).push(error); }
    }
    throwCleanupFailures(failures, "Completed program dependency cleanup failed.");
  }

  #enqueue<T>(steps: Generator<ExecutionStep, T, unknown>, release?: () => void,
    admit?: () => void): ExecutionRequest<T> {
    const request = new ExecutionRequest(
      steps,
      () => this.#advanceRequests(),
      () => this.#publishRequest(request),
      () => {
        // Publication is already authoritative. Report pin retirement failures
        // at session close without replacing the result or stranding drain.
        try { release?.(); }
        catch (error) { (this.#cleanupFailures ??= []).push(error); }
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
    // Register mandatory work before logical publication can retire an old
    // owner. Its physical cleanup may fail, but cannot cancel accepted work.
    try { admit?.(); }
    finally { this.#advanceRequests(); }
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

/** @internal Read the mode before Python assigns its native context capture. */
export function getRecordingMode(session: RuntimeSession): boolean {
  return runtimeSessionAccess(session).recordingMode();
}

/** @internal Enter a Python scope on the same recording owner as JavaScript. */
export function enterNoGradScope(session: RuntimeSession): boolean {
  return runtimeSessionAccess(session).enterNoGrad();
}

/** @internal Restore a captured scope mode, including after its owner closes. */
export function restoreRecordingMode(session: RuntimeSession, previous: boolean): void {
  if (typeof previous !== "boolean") throw new TypeError("A captured recording mode must be boolean.");
  runtimeSessionAccess(session).restoreRecording(previous);
}

/** @internal Python binding retains its own groups and language objects. */
export function registerOptimizerLease(session: RuntimeSession, groups: readonly (readonly Tensor[])[]): OptimizerLease {
  return runtimeSessionAccess(session).registerOptimizer(groups);
}

/** @internal Native registration eligibility without exposing autograd metadata. */
export function isOptimizableParameter(handle: Tensor): boolean {
  const state = requireTensorState(handle);
  assertTensorOpen(state);
  return state.history === null || state.history.recipe === null || state.identity.retained;
}

/** @internal Prepare the owned backend before entering a synchronous frontend. */
export function prepareRuntimeSession(session: RuntimeSession): Promise<void> {
  return runtimeSessionAccess(session).prepare();
}

/** @internal Join mandatory effects at managed entry completion. */
export function completeRuntimeSession(session: RuntimeSession): Promise<void> {
  return runtimeSessionAccess(session).complete();
}

/** @internal Automatic frontend retirement preserves fallible cleanup for close. */
export function finalizeTensorExposure(handle: Tensor): void {
  const state = requireTensorState(handle);
  if (state.closed) return;
  state.closed = true;
  unregisterTensorFinalizer(state);
  runtimeSessionAccess(state.session).finalizeHandle(state);
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
  beforeCopyPublication?: () => void,
  updateLimits?: Partial<UpdateLimits>,
): RuntimeSession {
  const testConfiguration: RuntimeSessionTestConfiguration = {
    forceVariant: options.forceVariant,
    ...(onProgramFormed === undefined ? {} : { onProgramFormed }),
    ...(beforeReadback === undefined ? {} : { beforeReadback }),
    ...(beforeCopyPublication === undefined ? {} : { beforeCopyPublication }),
    ...(updateLimits === undefined ? {} : { updateLimits }),
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

/** @internal Inspect actual descriptor reachability, beyond live-owner counters. */
export function inspectTensorReachabilityForTesting(handle: Tensor): { readonly values: number; readonly families: number } {
  const pending: object[] = [requireTensorState(handle).value];
  const seen = new Set<object>();
  let values = 0;
  let families = 0;
  while (pending.length !== 0) {
    const object = pending.pop()!;
    if (seen.has(object)) continue;
    seen.add(object);
    if (object instanceof TensorValue) values += 1;
    if (object instanceof TensorFamily) families += 1;
    for (const key of Object.keys(object)) {
      // Control outcomes and causal diagnostics are separate from numeric reachability.
      if (key === "outcomes" || key === "provenance") continue;
      const child: unknown = Reflect.get(object, key);
      if (typeof child === "object" && child !== null) pending.push(child);
    }
  }
  return { values, families };
}

/** @internal Inspect production owners, without retaining inspected objects. */
export function inspectRuntimeOwnershipForTesting(session: RuntimeSession): RuntimeOwnership {
  return runtimeSessionAccess(session).ownership();
}

/** @internal Snapshot semantic owning occurrences and cumulative collector work. */
export function inspectRuntimeSemanticOwnershipForTesting(session: RuntimeSession): RuntimeSemanticOwnership {
  return runtimeSessionAccess(session).semanticOwnership();
}

/** @internal Native version-counter diagnostic, outside the supported public API. */
export function inspectTensorVersionForTesting(handle: Tensor): number {
  return requireTensorState(handle).family.version;
}
