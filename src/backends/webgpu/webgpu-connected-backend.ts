import type { BackendCapabilities, ProgramBinding, ResidentAllocation } from "../../execution/backend.js";
import { TabgradError } from "../../shared/errors.js";
import type { ExecutableProgram, ProgramSlot } from "../../execution/executable-program.js";
import type { ExecutionTicket } from "../../execution/execution-ticket.js";
import { isRecord } from "../../shared/object-shape.js";
import type { WebGpuDiagnostics, WebGpuExecutionBackend } from "./webgpu-backend.js";
import { GPU_ACCOUNTED, GPU_CONSUMED, GPU_CONTROL_LENGTH, GPU_METRIC_LENGTH, GPU_PULSE, assertGpuConnectionActive,
  readGpuMetrics, retireGpuConnection, type WebGpuConnection, type WebGpuConnectionData } from "./webgpu-connection.js";
import { PendingGpuCompletions } from "./webgpu-pending-completions.js";
import { SharedGpuCompletion } from "./webgpu-shared-completion.js";

class ConnectedAllocation {
  constructor(readonly id: number) {}
}

/** Claim once across structured clones, before any fallible interpreter setup. */
export function consumeWebGpuConnection(connection: WebGpuConnection): WebGpuConnectionData {
  if (!isRecord(connection) || connection.connectionType !== "tabgrad-webgpu" || connection.protocolVersion !== 1
    || !(connection.port instanceof MessagePort) || !(connection.supervision instanceof MessagePort)
    || !(connection.control instanceof SharedArrayBuffer) || connection.control.byteLength !== GPU_CONTROL_LENGTH * 4
    || !(connection.metrics instanceof SharedArrayBuffer) || connection.metrics.byteLength !== GPU_METRIC_LENGTH * 8
    || !isRecord(connection.capabilities) || !isRecord(connection.diagnostics)) {
    throw new TabgradError("BACKEND_LOAD_FAILED", "A library-issued WebGPU connection is required.");
  }
  const control = new Int32Array(connection.control);
  if (Atomics.compareExchange(control, GPU_CONSUMED, 0, 1) !== 0) {
    throw new TabgradError("PYTHON_CONNECTION_IN_USE", "The WebGPU connection has already been consumed.");
  }
  return connection as unknown as WebGpuConnectionData;
}

/** Hand ownership back to the independently supervised producer on setup failure. */
export function retireFailedGpuAttachment(connection: WebGpuConnectionData): void {
  retireGpuConnection(new Int32Array(connection.control));
  try { connection.port.postMessage({ kind: "close" }); }
  finally { connection.port.close(); connection.supervision.close(); }
}

/** Physical transport below the runtime: no semantic tensor calls or numerical policy. */
export class ConnectedWebGpuBackend implements WebGpuExecutionBackend {
  readonly synchronousObservation = true;
  readonly capabilities: BackendCapabilities;
  readonly #connection: WebGpuConnectionData;
  readonly #control: Int32Array;
  readonly #pending: PendingGpuCompletions;
  readonly #allocations = new Map<number, ConnectedAllocation>();
  #closing: Promise<void> | undefined;

  constructor(connection: WebGpuConnectionData) {
    this.#connection = connection;
    this.#control = new Int32Array(connection.control);
    this.#pending = new PendingGpuCompletions(this.#control, (subscription) => connection.port.postMessage(subscription));
    assertGpuConnectionActive(this.#control);
    try { Atomics.wait(this.#control, GPU_PULSE, Atomics.load(this.#control, GPU_PULSE), 0); }
    catch (cause) {
      throw new TabgradError("SYNCHRONOUS_OBSERVATION_UNAVAILABLE", "Managed WebGPU attachment requires a worker where Atomics.wait is allowed.", {}, cause);
    }
    this.capabilities = Object.freeze({ ...connection.capabilities, computations: Object.freeze([...connection.capabilities.computations]) });
    connection.port.addEventListener("message", this.#onProgress);
    connection.supervision.addEventListener("message", this.#onProgress);
    connection.port.start();
    connection.supervision.start();
  }

  get ready(): boolean { return this.#closing === undefined && Atomics.load(this.#control, 0) === 0; }

  assertAvailable(): void {
    this.#onProgress();
    assertGpuConnectionActive(this.#control);
    if (this.#closing !== undefined) throw new TabgradError("CLOSED_SESSION", "The connected WebGPU backend is closed.");
  }

  diagnostics(): WebGpuDiagnostics {
    const snapshot = readGpuMetrics(this.#connection.metrics, this.#connection.diagnostics, this.#control);
    return this.#closing === undefined ? snapshot : Object.freeze({ ...snapshot, state: snapshot.state === "ready" ? "closed" : snapshot.state });
  }

  prepare(_program?: ExecutableProgram): undefined {
    this.assertAvailable();
    // Pipeline preparation progresses in the physical worker as part of its
    // finite execution ticket. No complete definition is staged between RPCs.
    return undefined;
  }

  execute(program: ExecutableProgram, bindings: ReadonlyMap<ProgramSlot, ProgramBinding>, retainedSlots: readonly boolean[]):
    ExecutionTicket<ReadonlyMap<ProgramSlot, ResidentAllocation>> {
    this.assertAvailable();
    const transferables: Transferable[] = [];
    const entries = [...bindings].map(([slot, binding]) => {
      if (binding.resident !== undefined) return { slot, resident: this.#requireAllocation(binding.resident).id };
      if (binding.hostData === undefined) throw new TabgradError("BACKEND_STATUS_ERROR", "Missing GPU binding.");
      const hostData = binding.hostData.slice();
      transferables.push(hostData.buffer);
      return { slot, hostData };
    });
    return this.#request({ kind: "execute", program, bindings: entries, retainedSlots }, program.values.length * 16,
      (payload) => this.#decodeAllocations(payload), transferables).ticket;
  }

  read(allocation: ResidentAllocation, length: number): ExecutionTicket<Float32Array> {
    this.assertAvailable();
    const resident = this.#requireAllocation(allocation);
    return this.#request({ kind: "read", allocation: resident.id, length }, length * 4,
      (payload) => {
        if (payload.byteLength !== length * 4) throw new TabgradError("BACKEND_STATUS_ERROR", "Invalid GPU readback extent.");
        return new Float32Array(payload.buffer, payload.byteOffset, length).slice();
      }).ticket;
  }

  release(allocation: ResidentAllocation): void {
    const resident = this.#requireAllocation(allocation);
    this.#allocations.delete(resident.id);
    if (Atomics.load(this.#control, 0) !== 0) return;
    this.#request({ kind: "release", allocation: resident.id }, 0, () => undefined).read();
  }

  close(): Promise<void> {
    this.#closing ??= Promise.resolve().then(() => this.#close());
    return this.#closing;
  }

  #close(): void {
    if (Atomics.load(this.#control, GPU_ACCOUNTED) === 0) this.#connection.port.postMessage({ kind: "close" });
    while (Atomics.load(this.#control, GPU_ACCOUNTED) === 0) {
      const pulse = Atomics.load(this.#control, GPU_PULSE);
      if (Atomics.load(this.#control, GPU_ACCOUNTED) === 0) Atomics.wait(this.#control, GPU_PULSE, pulse);
    }
    this.#onProgress();
    this.#allocations.clear();
    this.#connection.port.close();
    this.#connection.supervision.close();
    if (Atomics.load(this.#control, GPU_ACCOUNTED) === 2) {
      throw new TabgradError("BACKEND_STATUS_ERROR", "GPU worker cleanup was not acknowledged.", { physicalCompletion: "unknown" });
    }
  }

  readonly #onProgress = (): void => {
    this.#pending.advance();
  };

  #request<T>(message: Record<string, unknown>, bytes: number, decode: (payload: Uint8Array) => T, transferables: Transferable[] = []): SharedGpuCompletion<T> {
    this.#onProgress();
    assertGpuConnectionActive(this.#control);
    const completion: SharedGpuCompletion<T> = new SharedGpuCompletion(this.#control, bytes, decode, () => this.#pending.delete(completion),
      () => this.#pending.failed(completion));
    const requestId = this.#pending.add(completion);
    try { this.#connection.port.postMessage({ ...message, requestId, completion: completion.buffer }, transferables); }
    catch (error) {
      this.#pending.delete(completion);
      retireGpuConnection(this.#control);
      this.#onProgress();
      throw new TabgradError("BACKEND_STATUS_ERROR", "GPU request transfer failed.", { phase: "transport" }, error);
    }
    return completion;
  }

  #requireAllocation(allocation: ResidentAllocation): ConnectedAllocation {
    if (!(allocation instanceof ConnectedAllocation) || this.#allocations.get(allocation.id) !== allocation) {
      throw new TabgradError("BACKEND_STATUS_ERROR", "A foreign or released connected GPU allocation was used.");
    }
    return allocation;
  }

  #decodeAllocations(payload: Uint8Array): ReadonlyMap<ProgramSlot, ResidentAllocation> {
    if (payload.byteLength % 16 !== 0) throw new TabgradError("BACKEND_STATUS_ERROR", "Invalid GPU allocation mapping.");
    const pairs = new Float64Array(payload.buffer, payload.byteOffset, payload.byteLength / 8);
    const result = new Map<ProgramSlot, ResidentAllocation>();
    for (let index = 0; index < pairs.length; index += 2) {
      const slot = pairs[index]!;
      const id = pairs[index + 1]!;
      if (!Number.isSafeInteger(slot) || slot < 0 || !Number.isSafeInteger(id) || id <= 0 || result.has(slot)) {
        throw new TabgradError("BACKEND_STATUS_ERROR", "Invalid connected GPU identity.");
      }
      let allocation = this.#allocations.get(id);
      if (allocation === undefined) { allocation = new ConnectedAllocation(id); this.#allocations.set(id, allocation); }
      result.set(slot, allocation);
    }
    return result;
  }
}
