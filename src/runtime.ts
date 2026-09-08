import {
  type ProgramBinding,
  type ResidentAllocation,
  type WasmVariant,
  WebAssemblyCpuBackend,
} from "./cpu-backend.js";
import {
  TabgradError,
  retainExecutionFailureContext,
} from "./errors.js";
import {
  ExecutableProgram,
  type LoweredAddFloat32,
  type ProgramProvenance,
  type ProgramSlot,
  type ProgramValue,
} from "./executable-program.js";

export type TensorDType = "float32";
export type TensorDevice = "cpu";
export type TensorLayout = "contiguous";

export interface TensorOptions {
  readonly dtype?: TensorDType;
  readonly device?: TensorDevice;
  readonly layout?: TensorLayout;
  readonly shape?: readonly number[];
}

export interface RuntimeSessionOptions {
  readonly manifestUrl?: string | URL;
}

export interface RuntimeDiagnostics {
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
}

interface TensorMetadata {
  readonly shape: readonly [number];
  readonly dtype: TensorDType;
  readonly device: TensorDevice;
  readonly layout: TensorLayout;
}

interface AdmittedOperation {
  readonly record: OperationRecord;
  readonly outputMetadata: TensorMetadata;
}

interface OperationDefinition {
  readonly name: "add";
  readonly provenanceSource: "Tensor.add";
  readonly loweredKind: "add-f32";
  readonly pure: true;
  admit(
    session: RuntimeSession,
    left: TensorState,
    rightHandle: unknown,
  ): AdmittedOperation;
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

function invalidTensorShape(dataLength: number, cause?: unknown): TabgradError {
  return new TabgradError(
    "INVALID_SHAPE",
    "This runtime slice requires one dimension equal to the data length.",
    {
      operation: "tensor",
      contract: "one-dimensional-shape",
      dataLength,
    },
    cause,
  );
}

function copyTensorShape(shape: unknown, dataLength: number): readonly [number] {
  if (shape === undefined) {
    return Object.freeze([dataLength]);
  }
  try {
    if (!Array.isArray(shape) || shape.length !== 1) {
      throw invalidTensorShape(dataLength);
    }
    const firstDimension: unknown = shape[0];
    if (
      typeof firstDimension !== "number"
      || !Number.isSafeInteger(firstDimension)
      || firstDimension < 0
      || firstDimension !== dataLength
    ) {
      throw invalidTensorShape(dataLength);
    }
    return Object.freeze([firstDimension]);
  } catch (error) {
    if (error instanceof TabgradError) {
      throw error;
    }
    throw invalidTensorShape(dataLength, error);
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
      { ...error.details, backend: "webassembly-cpu", phase },
      error.cause ?? error,
    )
    : new TabgradError(
      "BACKEND_STATUS_ERROR",
      "The WebAssembly CPU request failed.",
      { backend: "webassembly-cpu", phase: fallbackPhase },
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
    backendEndpoints: ["webassembly-cpu"],
    phase,
  });
}

class TensorValue {
  readonly shape: readonly [number];
  readonly dtype: TensorDType;
  readonly device: TensorDevice;
  readonly layout: TensorLayout;
  readonly producer: OperationRecord | null;
  readonly provenance: ProgramProvenance;
  references = 1;
  dependenciesReleased = false;

  constructor(metadata: TensorMetadata, producer: OperationRecord | null) {
    this.shape = Object.freeze([...metadata.shape]) as readonly [number];
    this.dtype = metadata.dtype;
    this.device = metadata.device;
    this.layout = metadata.layout;
    this.producer = producer;
    this.provenance = producer?.provenance ?? Object.freeze({
      operation: "tensor",
      source: "RuntimeSession.tensor",
    });
  }
}

class OperationRecord {
  readonly definition: OperationDefinition;
  readonly inputs: readonly [TensorValue, TensorValue];
  readonly provenance: ProgramProvenance;

  constructor(
    definition: OperationDefinition,
    inputs: readonly [TensorValue, TensorValue],
  ) {
    this.definition = definition;
    this.inputs = Object.freeze([...inputs]) as unknown as readonly [TensorValue, TensorValue];
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

  constructor(session: RuntimeSession, value: TensorValue) {
    this.session = session;
    this.value = value;
  }
}

type Materialization =
  | { readonly kind: "host"; readonly data: Float32Array }
  | {
    readonly kind: "resident";
    readonly allocation: ResidentAllocation;
  };

class MaterializationTable {
  readonly #entries = new Map<TensorValue, Materialization>();

  get(value: TensorValue): Materialization | undefined {
    return this.#entries.get(value);
  }

  setHost(value: TensorValue, data: Float32Array): void {
    this.#entries.set(value, { kind: "host", data });
  }

  setResident(
    value: TensorValue,
    allocation: ResidentAllocation,
  ): void {
    this.#entries.set(value, { kind: "resident", allocation });
  }

  delete(value: TensorValue): Materialization | undefined {
    const entry = this.#entries.get(value);
    this.#entries.delete(value);
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

interface FormedProgram {
  readonly program: ExecutableProgram;
  readonly bindings: ReadonlyMap<ProgramSlot, ProgramBinding>;
  readonly valuesBySlot: ReadonlyMap<ProgramSlot, TensorValue>;
  readonly newlyComputed: readonly TensorValue[];
}

interface RuntimeSessionTestConfiguration {
  readonly forceVariant: WasmVariant;
  readonly onProgramFormed?: (program: ExecutableProgram) => void;
  readonly beforeReadback?: () => void;
}

const RUNTIME_SESSION_TEST_CONFIGURATION = Symbol("RuntimeSessionTestConfiguration");

interface InternalRuntimeSessionOptions extends RuntimeSessionOptions {
  readonly [RUNTIME_SESSION_TEST_CONFIGURATION]?: RuntimeSessionTestConfiguration;
}

interface RuntimeSessionAccess {
  readonly add: (left: TensorState, rightHandle: unknown) => Tensor;
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
let inspectTensorState: ((handle: unknown) => TensorState | null) | undefined;
const TENSOR_CONSTRUCTION_TOKEN = Symbol("TensorConstructionToken");

function createTensorHandle(state: TensorState): Tensor {
  if (constructTensorHandle === undefined) {
    throw new Error("Tensor construction is not initialized.");
  }
  return constructTensorHandle(state);
}

function tensorStateFromHandle(handle: unknown): TensorState | null {
  return inspectTensorState?.(handle) ?? null;
}

export class Tensor {
  readonly #state: TensorState;

  private constructor(state: TensorState, token: symbol) {
    if (token !== TENSOR_CONSTRUCTION_TOKEN) {
      throw new TabgradError(
        "INVALID_TENSOR",
        "Tensor handles can only be created by a runtime session.",
      );
    }
    this.#state = state;
  }

  static {
    constructTensorHandle = (state) => new Tensor(state, TENSOR_CONSTRUCTION_TOKEN);
    inspectTensorState = (handle) => handle instanceof Tensor ? handle.#state : null;
  }

  get shape(): readonly [number] {
    this.#assertOpen();
    return this.#state.value.shape;
  }

  get dtype(): TensorDType {
    this.#assertOpen();
    return this.#state.value.dtype;
  }

  get device(): TensorDevice {
    this.#assertOpen();
    return this.#state.value.device;
  }

  add(right: Tensor): Tensor {
    return runtimeSessionAccess(this.#state.session).add(this.#state, right);
  }

  toArray(): Promise<Float32Array> {
    this.#assertOpen();
    return runtimeSessionAccess(this.#state.session).observe(this.#state);
  }

  close(): void {
    if (!this.#state.closed) {
      this.#state.closed = true;
      runtimeSessionAccess(this.#state.session).releaseHandle(this.#state);
    }
  }

  #assertOpen(): void {
    if (this.#state.closed) {
      throw new TabgradError("CLOSED_TENSOR", "The tensor handle is closed.");
    }
    runtimeSessionAccess(this.#state.session).assertOpen();
  }
}

class AddOperationDefinition implements OperationDefinition {
  readonly name = "add";
  readonly provenanceSource = "Tensor.add";
  readonly loweredKind = "add-f32";
  readonly pure = true;

  admit(
    session: RuntimeSession,
    left: TensorState,
    rightHandle: unknown,
  ): AdmittedOperation {
    const right = tensorStateFromHandle(rightHandle);
    if (right === null) {
      throw new TabgradError(
        "INVALID_TENSOR",
        "Float32 addition requires another Tabgrad tensor handle.",
        { operation: this.name, contract: "tensor-handle" },
      );
    }
    if (left.closed || right.closed) {
      throw new TabgradError(
        "CLOSED_TENSOR",
        "Float32 addition requires open tensor handles.",
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
        "Both addition inputs must belong to the same runtime session.",
        { operation: this.name, contract: "same-session" },
      );
    }
    if (left.value.dtype !== "float32" || right.value.dtype !== "float32") {
      throw new TabgradError(
        "UNSUPPORTED_DTYPE",
        "Float32 addition requires float32 inputs.",
        {
          operation: this.name,
          contract: "float32-inputs",
          leftDType: left.value.dtype,
          rightDType: right.value.dtype,
        },
      );
    }
    if (left.value.device !== "cpu" || right.value.device !== "cpu") {
      throw new TabgradError(
        "UNSUPPORTED_DEVICE",
        "This addition definition supports only CPU inputs.",
        {
          operation: this.name,
          contract: "cpu-inputs",
          leftDevice: left.value.device,
          rightDevice: right.value.device,
        },
      );
    }
    if (left.value.layout !== "contiguous" || right.value.layout !== "contiguous") {
      throw new TabgradError(
        "UNSUPPORTED_LAYOUT",
        "This addition definition supports only contiguous inputs.",
        {
          operation: this.name,
          contract: "contiguous-inputs",
          leftLayout: left.value.layout,
          rightLayout: right.value.layout,
        },
      );
    }
    if (left.value.shape[0] !== right.value.shape[0]) {
      throw new TabgradError(
        "SHAPE_MISMATCH",
        "Float32 addition requires equal one-dimensional shapes.",
        {
          operation: this.name,
          contract: "equal-shape",
          leftShape: left.value.shape,
          rightShape: right.value.shape,
        },
      );
    }

    const inputs = Object.freeze([
      left.value,
      right.value,
    ]) as unknown as readonly [TensorValue, TensorValue];
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

const ADD_OPERATION: OperationDefinition = Object.freeze(new AddOperationDefinition());

export class RuntimeSession {
  #backend: WebAssemblyCpuBackend;
  readonly #materializations = new MaterializationTable();
  readonly #states = new Set<TensorState>();
  readonly #values = new Set<TensorValue>();
  #tail: Promise<void> = Promise.resolve();
  #closed = false;
  #closePromise: Promise<void> | null = null;
  #operationRecords = 0;
  #requestLeases = 0;
  #onProgramFormed: ((program: ExecutableProgram) => void) | undefined;
  #beforeReadback: (() => void) | undefined;

  constructor(options: RuntimeSessionOptions = {}) {
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
      add: (left: TensorState, rightHandle: unknown) => (
        this.#add(left, rightHandle)
      ),
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
    if (options.dtype !== undefined && options.dtype !== "float32") {
      throw new TabgradError(
        "UNSUPPORTED_DTYPE",
        "This runtime slice supports only float32 tensors.",
        { operation: "tensor", contract: "float32-dtype", dtype: options.dtype },
      );
    }
    if (options.device !== undefined && options.device !== "cpu") {
      throw new TabgradError(
        "UNSUPPORTED_DEVICE",
        "This runtime slice supports only the CPU device.",
        { operation: "tensor", contract: "cpu-device", device: options.device },
      );
    }
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
    const shape = copyTensorShape(options.shape, payload.length);
    const value = new TensorValue({
      shape,
      dtype: "float32",
      device: "cpu",
      layout: "contiguous",
    }, null);
    this.#registerValue(value);
    this.#materializations.setHost(value, payload);
    return this.#createHandle(value);
  }

  #add(left: TensorState, rightHandle: unknown): Tensor {
    this.#assertOpen();
    const admitted = ADD_OPERATION.admit(this, left, rightHandle);
    for (const input of admitted.record.inputs) {
      this.#retainValue(input);
    }
    const result = new TensorValue(admitted.outputMetadata, admitted.record);
    this.#registerValue(result);
    return this.#createHandle(result);
  }

  #observe(state: TensorState): Promise<Float32Array> {
    this.#assertOpen();
    this.#retainValue(state.value);
    return this.#enqueue(async () => {
      try {
        const materialization = await this.#materialize(state.value);
        try {
          this.#beforeReadback?.();
          return this.#backend.read(
            materialization.allocation,
            state.value.shape[0],
          );
        } catch (error) {
          throw retainProgramFailureContext(
            error,
            materialization.program,
            "readback",
          );
        }
      } finally {
        this.#releaseValue(state.value);
      }
    });
  }

  diagnostics(): RuntimeDiagnostics {
    return Object.freeze({
      ...this.#backend.diagnostics(),
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
    await this.#tail;
    for (const materialization of this.#materializations.values()) {
      if (materialization.kind === "resident") {
        this.#backend.release(materialization.allocation);
      }
    }
    this.#materializations.clear();
    await this.#backend.close();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new TabgradError("CLOSED_SESSION", "The runtime session is closed.");
    }
  }

  #releaseHandle(state: TensorState): void {
    this.#states.delete(state);
    this.#releaseValue(state.value);
  }

  #createHandle(value: TensorValue): Tensor {
    const state = new TensorState(this, value);
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
  }

  #releaseValue(value: TensorValue): void {
    value.references -= 1;
    if (value.references > 0) {
      return;
    }
    if (value.references < 0) {
      throw new TabgradError(
        "BACKEND_STATUS_ERROR",
        "A tensor value was released more times than it was retained.",
      );
    }
    this.#values.delete(value);
    if (value.producer !== null) {
      this.#operationRecords -= 1;
    }
    const materialization = this.#materializations.delete(value);
    if (materialization?.kind === "resident") {
      this.#backend.release(materialization.allocation);
    }
    this.#releaseDependencies(value);
  }

  #releaseDependencies(value: TensorValue): void {
    if (value.producer === null || value.dependenciesReleased) {
      return;
    }
    value.dependenciesReleased = true;
    for (const input of value.producer.inputs) {
      this.#releaseValue(input);
    }
  }

  async #materialize(value: TensorValue): Promise<{
    readonly allocation: ResidentAllocation;
    readonly program: ExecutableProgram;
  }> {
    const formed = this.#formProgram(value);
    const existing = this.#materializations.get(value);
    if (existing?.kind === "resident") {
      return { allocation: existing.allocation, program: formed.program };
    }
    try {
      const allocations = await this.#backend.execute(formed.program, formed.bindings);
      for (const [slot, allocation] of allocations) {
        const boundValue = formed.valuesBySlot.get(slot);
        if (boundValue === undefined) {
          throw new TabgradError(
            "BACKEND_STATUS_ERROR",
            "The backend returned an allocation for an unknown program slot.",
            { backend: "webassembly-cpu", phase: "execution", slot },
          );
        }
        const existingMaterialization = this.#materializations.get(boundValue);
        if (existingMaterialization?.kind === "resident") {
          if (existingMaterialization.allocation !== allocation) {
            throw new TabgradError(
              "BACKEND_STATUS_ERROR",
              "The backend replaced a live resident allocation.",
              {
                backend: "webassembly-cpu",
                phase: "execution",
                slot,
              },
            );
          }
          continue;
        }
        this.#materializations.setResident(boundValue, allocation);
      }
      for (const computedValue of formed.newlyComputed) {
        this.#releaseDependencies(computedValue);
      }
      const result = this.#materializations.get(value);
      if (result?.kind !== "resident") {
        throw new TabgradError(
          "BACKEND_STATUS_ERROR",
          "Execution completed without materializing the demanded result.",
          { backend: "webassembly-cpu", phase: "execution" },
        );
      }
      return { allocation: result.allocation, program: formed.program };
    } catch (error) {
      throw retainProgramFailureContext(error, formed.program, "execution");
    }
  }

  #formProgram(root: TensorValue): FormedProgram {
    const slots = new Map<TensorValue, ProgramSlot>();
    const values: ProgramValue[] = [];
    const computations: LoweredAddFloat32[] = [];
    const bindings = new Map<ProgramSlot, ProgramBinding>();
    const valuesBySlot = new Map<ProgramSlot, TensorValue>();
    const newlyComputed: TensorValue[] = [];

    const visit = (value: TensorValue): ProgramSlot => {
      const known = slots.get(value);
      if (known !== undefined) {
        return known;
      }
      const materialization = this.#materializations.get(value);
      const producer = materialization?.kind === "resident" ? null : value.producer;
      const inputSlots = producer === null
        ? undefined
        : producer.inputs.map(visit) as [ProgramSlot, ProgramSlot];
      const slot = values.length;
      slots.set(value, slot);
      valuesBySlot.set(slot, value);
      values.push({
        slot,
        dtype: value.dtype,
        device: value.device,
        layout: value.layout,
        shape: value.shape,
        source: producer === null ? "binding" : "computed",
        provenance: value.provenance,
      });
      if (materialization?.kind === "host") {
        bindings.set(slot, { hostData: materialization.data });
      } else if (materialization?.kind === "resident") {
        bindings.set(slot, { resident: materialization.allocation });
      }
      if (producer !== null && inputSlots !== undefined) {
        computations.push({
          kind: producer.definition.loweredKind,
          left: inputSlots[0],
          right: inputSlots[1],
          output: slot,
          provenance: producer.provenance,
        });
        newlyComputed.push(value);
      }
      return slot;
    };

    const result = visit(root);
    const program = new ExecutableProgram(values, computations, result);
    this.#onProgramFormed?.(program);
    return {
      program,
      bindings,
      valuesBySlot,
      newlyComputed,
    };
  }

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    this.#requestLeases += 1;
    const execution = this.#tail.then(task, task);
    const result = execution.finally(() => {
      this.#requestLeases -= 1;
    });
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export function createRuntimeSession(options: RuntimeSessionOptions = {}): RuntimeSession {
  return new RuntimeSession(options);
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
