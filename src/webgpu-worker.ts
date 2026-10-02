import { WebGpuBackend } from "./webgpu-backend.js";
import type { ProgramBinding, ResidentAllocation } from "./execution/backend.js";
import { ExecutableProgram } from "./execution/executable-program.js";
import { ExecutionTicket } from "./execution/execution-ticket.js";
import { acquireWebGpuDevice } from "./webgpu-device.js";
import { GPU_ACCOUNTED, GPU_CONTROL_LENGTH, GPU_METRIC_LENGTH, assertGpuConnectionActive, retireGpuConnection, writeGpuMetrics } from "./webgpu-connection.js";
import { publishSharedGpuDrain, publishSharedGpuFailure, publishSharedGpuSuccess } from "./webgpu-shared-completion.js";
import { TabgradError } from "./shared/errors.js";
import { isRecord } from "./shared/object-shape.js";

interface PhysicalWorkerScope {
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: unknown): void;
}

/** The packaged entry owns device acquisition even after the host cancels. */
class PhysicalGpuWorker {
  readonly #scope: PhysicalWorkerScope;
  #backend: WebGpuBackend | undefined;
  #control: Int32Array | undefined;
  #port: MessagePort | undefined;
  #acquisition: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  #metrics: SharedArrayBuffer | undefined;
  readonly #pending = new Set<Promise<void>>();
  readonly #allocations = new Map<number, ResidentAllocation>();
  readonly #identities = new WeakMap<ResidentAllocation, number>();
  #nextAllocation = 0;

  constructor(scope: PhysicalWorkerScope) {
    this.#scope = scope;
    scope.addEventListener("message", this.#onMessage);
  }

  readonly #onMessage = (event: MessageEvent<unknown>): void => {
    if (!isRecord(event.data)) return;
    const message = event.data;
    if (message.kind === "initialize" && this.#acquisition === undefined
      && message.port instanceof MessagePort && message.control instanceof SharedArrayBuffer
      && message.control.byteLength === GPU_CONTROL_LENGTH * Int32Array.BYTES_PER_ELEMENT
      && message.metrics instanceof SharedArrayBuffer && message.metrics.byteLength === GPU_METRIC_LENGTH * 8) {
      this.#control = new Int32Array(message.control);
      this.#port = message.port;
      this.#metrics = message.metrics;
      this.#port.addEventListener("message", this.#onBackendMessage);
      this.#port.start();
      this.#acquisition = this.#acquire();
    } else if (message.kind === "close") {
      if (this.#control !== undefined) retireGpuConnection(this.#control);
      this.#closing ??= this.#close();
    }
  };

  readonly #onBackendMessage = (event: MessageEvent<unknown>): void => {
    if (!isRecord(event.data)) return;
    const message = event.data;
    if (message.kind === "close") {
      this.#closing ??= this.#close();
      return;
    }
    if (!(message.completion instanceof SharedArrayBuffer)) return;
    const completion = message.completion;
    const work = this.#run(message, completion);
    this.#pending.add(work);
    void work.finally(() => this.#pending.delete(work));
  };

  async #run(message: Record<string, unknown>, completion: SharedArrayBuffer): Promise<void> {
    let drained: Promise<void> | undefined;
    try {
      assertGpuConnectionActive(this.#control!);
      if (this.#backend === undefined || this.#closing !== undefined) throw new TabgradError("CLOSED_SESSION", "GPU service is unavailable.");
      const pending = this.#perform(message);
      this.#updateMetrics();
      let result: Uint8Array;
      if (pending instanceof ExecutionTicket) {
        drained = pending.drained;
        result = await pending.result;
      } else result = await pending;
      await drained;
      this.#updateMetrics();
      // Success is published after drain so parked Python can retire pins
      // without needing Promise callbacks in its own realm.
      publishSharedGpuSuccess(completion, this.#control!, result);
    } catch (error) {
      this.#updateMetrics();
      publishSharedGpuFailure(completion, this.#control!, error);
      this.#port!.postMessage({ kind: "progress" });
      await drained;
      this.#updateMetrics();
      publishSharedGpuDrain(completion, this.#control!);
    } finally {
      this.#port!.postMessage({ kind: "progress" });
    }
  }

  #perform(message: Record<string, unknown>): Uint8Array | Promise<Uint8Array> | ExecutionTicket<Uint8Array> {
    const backend = this.#backend!;
    if (message.kind === "execute") {
      const definition = message.program as ExecutableProgram;
      const program = new ExecutableProgram(definition.values, definition.computations, definition.result);
      const bindings = new Map<number, ProgramBinding>();
      for (const binding of message.bindings as { slot: number; resident?: number; hostData?: Float32Array }[]) {
        bindings.set(binding.slot, binding.resident === undefined ? { hostData: binding.hostData! }
          : { resident: this.#requireAllocation(binding.resident) });
      }
      const state: { execution?: ExecutionTicket<ReadonlyMap<number, ResidentAllocation>> } = {};
      const result = this.#executePrepared(program, bindings, message.retainedSlots as readonly boolean[], state)
        .then((allocations) => this.#encodeAllocations(allocations));
      const drained = result.then(() => state.execution?.drained, () => state.execution?.drained).then(() => undefined);
      return new ExecutionTicket(result, drained);
    }
    if (message.kind === "read") {
      const result = backend.read(this.#requireAllocation(message.allocation as number), message.length as number);
      if (!(result instanceof ExecutionTicket)) return new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
      return new ExecutionTicket(result.result.then((value) => new Uint8Array(value.buffer, value.byteOffset, value.byteLength)), result.drained);
    }
    if (message.kind === "release") {
      const id = message.allocation as number;
      backend.release(this.#requireAllocation(id));
      this.#allocations.delete(id);
      return new Uint8Array();
    }
    throw new TabgradError("BACKEND_STATUS_ERROR", "Unknown GPU backend request.");
  }

  async #executePrepared(
    program: ExecutableProgram,
    bindings: ReadonlyMap<number, ProgramBinding>,
    retainedSlots: readonly boolean[],
    state: { execution?: ExecutionTicket<ReadonlyMap<number, ResidentAllocation>> },
  ): Promise<ReadonlyMap<number, ResidentAllocation>> {
    await this.#backend!.prepare(program);
    assertGpuConnectionActive(this.#control!);
    state.execution = this.#backend!.execute(program, bindings, retainedSlots);
    this.#updateMetrics();
    return await state.execution.result;
  }

  #encodeAllocations(allocations: ReadonlyMap<number, ResidentAllocation>): Uint8Array {
    const pairs = new Float64Array(allocations.size * 2);
    let offset = 0;
    for (const [slot, allocation] of allocations) {
      let id = this.#identities.get(allocation);
      if (id === undefined) {
        this.#nextAllocation += 1;
        if (!Number.isSafeInteger(this.#nextAllocation)) throw new TabgradError("RESOURCE_EXHAUSTED", "GPU allocation identity space is exhausted.");
        id = this.#nextAllocation;
        this.#identities.set(allocation, id);
      }
      this.#allocations.set(id, allocation);
      pairs[offset++] = slot;
      pairs[offset++] = id;
    }
    return new Uint8Array(pairs.buffer);
  }

  #requireAllocation(id: number): ResidentAllocation {
    const allocation = this.#allocations.get(id);
    if (allocation === undefined) throw new TabgradError("BACKEND_STATUS_ERROR", "Unknown GPU allocation identity.");
    return allocation;
  }

  #updateMetrics(): void {
    if (this.#backend !== undefined && this.#metrics !== undefined) writeGpuMetrics(this.#metrics, this.#backend.diagnostics());
  }

  async #acquire(): Promise<void> {
    try {
      const device = await acquireWebGpuDevice();
      this.#backend = new WebGpuBackend(device);
      void device.lost.then(() => {
        if (this.#closing !== undefined) return;
        if (this.#control !== undefined) retireGpuConnection(this.#control);
        this.#scope.postMessage({ kind: "failure" });
        this.#closing ??= this.#close();
      });
      await Promise.resolve();
      assertGpuConnectionActive(this.#control!);
      this.#backend.assertAvailable();
      this.#updateMetrics();
      this.#scope.postMessage({ kind: "ready", capabilities: this.#backend.capabilities, diagnostics: this.#backend.diagnostics() });
    } catch (_error) {
      this.#scope.postMessage({ kind: "failure" });
      // Do not await close here: it joins this acquisition itself.
      this.#closing ??= this.#close();
    }
  }

  async #close(): Promise<void> {
    try {
      await this.#acquisition;
      await Promise.allSettled(this.#pending);
      await this.#backend?.close();
      this.#allocations.clear();
      this.#updateMetrics();
      if (this.#control !== undefined) {
        Atomics.store(this.#control, GPU_ACCOUNTED, 1);
        retireGpuConnection(this.#control);
      }
      this.#port?.postMessage({ kind: "progress" });
      this.#port?.close();
      this.#scope.postMessage({ kind: "closed" });
    } catch (_error) {
      if (this.#control !== undefined) retireGpuConnection(this.#control);
      this.#port?.close();
      this.#scope.postMessage({ kind: "lost" });
    }
  }
}

new PhysicalGpuWorker(globalThis as unknown as PhysicalWorkerScope);
