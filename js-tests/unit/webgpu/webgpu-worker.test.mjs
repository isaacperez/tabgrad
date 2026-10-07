import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import * as python from "../../../dist/python.js";
import { startWebGpuWorker } from "../../../dist/backends/webgpu/worker.js";
import { TabgradError } from "../../../dist/shared/errors.js";

const capabilities = { device: "webgpu", computations: ["add-f32"], gradients: false, maximumTensorBytes: 1048576 };
const diagnostics = {
  state: "ready", adapter: { vendor: "test", architecture: "test", device: "test", description: "test", isFallbackAdapter: false },
  features: [], limits: { maxBufferSize: 1048576, maxStorageBufferBindingSize: 1048576, maxComputeWorkgroupsPerDimension: 64 },
  ownedBufferBytes: 0, peakOwnedBufferBytes: 0, pendingSubmissions: 0, unknownCompletionBytes: 0, uploadBytes: 0, readbackBytes: 0, kernelCalls: 0,
};

class ControlledWorker extends EventTarget {
  static instances = [];
  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.messages = [];
    this.terminated = false;
    ControlledWorker.instances.push(this);
  }
  postMessage(message, transferables) {
    this.messages.push({ message, transferables });
    if (message.kind === "initialize") this.initialization = message;
  }
  ready(advertised = capabilities) { this.dispatchEvent(new MessageEvent("message", { data: { kind: "ready", capabilities: advertised, diagnostics } })); }
  closed() {
    this.initialization?.port.close();
    this.dispatchEvent(new MessageEvent("message", { data: { kind: "closed" } }));
  }
  terminate() { this.terminated = true; }
}

function workerEnvironment() {
  ControlledWorker.instances = [];
  return environment({ isSecureContext: true, crossOriginIsolated: true, Worker: ControlledWorker });
}

function environment(values) {
  const descriptors = new Map();
  for (const [name, value] of Object.entries(values)) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  return () => {
    for (const [name, descriptor] of descriptors) {
      if (descriptor === undefined) delete globalThis[name];
      else Object.defineProperty(globalThis, name, descriptor);
    }
  };
}

/** Replace acquisition and the worker scope, keeping both packaged endpoints. */
async function acquisitionFailure(gpu, withholdAcknowledgment = false) {
  let listener;
  const replies = [];
  const closed = Promise.withResolvers();
  class EndpointWorker extends ControlledWorker {
    postMessage(message, transferables) {
      super.postMessage(message, transferables);
      listener(new MessageEvent("message", { data: structuredClone(message, { transfer: transferables ?? [] }) }));
    }
  }
  ControlledWorker.instances = [];
  const restore = environment({
    isSecureContext: true, crossOriginIsolated: true, Worker: EndpointWorker, navigator: { gpu },
    addEventListener: (type, onMessage) => { assert.equal(type, "message"); listener = onMessage; },
    postMessage: (message) => {
      const copy = structuredClone(message);
      replies.push(copy);
      if (copy.kind !== "closed" || !withholdAcknowledgment) {
        ControlledWorker.instances.at(-1).dispatchEvent(new MessageEvent("message", { data: copy }));
      }
      if (copy.kind === "closed") closed.resolve();
    },
  });
  try {
    startWebGpuWorker();
    let error;
    try { await python.createWebGpuWorker(); }
    catch (failure) { error = failure; }
    await closed.promise;
    const worker = ControlledWorker.instances.at(-1);
    return { error, worker, replies, control: new Int32Array(worker.initialization.control) };
  } finally { restore(); }
}

test("actual GPU worker acquisition preserves distinct originating diagnostics", async () => {
  const adapterFailure = new Error("specific adapter acquisition failure");
  adapterFailure.name = "AdapterError";
  adapterFailure.privateData = { tensor: new Float32Array(32) };
  adapterFailure.cause = adapterFailure;
  const deviceFailure = new Error("specific device acquisition failure");
  deviceFailure.name = "DeviceError";
  for (const [gpu, code, message, native] of [
    [undefined, "UNSUPPORTED_DEVICE", "WebGPU is unavailable in this environment.", undefined],
    [{ requestAdapter: async () => null }, "UNSUPPORTED_DEVICE", "No WebGPU adapter is available.", undefined],
    [{ requestAdapter: async () => { throw adapterFailure; } }, "BACKEND_LOAD_FAILED", "WebGPU device acquisition failed.", adapterFailure],
    [{ requestAdapter: async () => ({ requestDevice: async () => { throw deviceFailure; } }) }, "BACKEND_LOAD_FAILED", "WebGPU device acquisition failed.", deviceFailure],
  ]) {
    const { error, worker, replies, control } = await acquisitionFailure(gpu);
    assert.equal(error.code, "BACKEND_LOAD_FAILED");
    assert.equal(error.details.phase, "worker-setup");
    assert.equal(error.cause?.code, code);
    assert.equal(error.cause.message, message);
    assert.equal(error.cause.details.phase, "device-acquisition");
    assert.equal(error.cause.details.diagnosticTruncated, false);
    assert.equal(error.cause.cause?.name, native?.name);
    assert.equal(error.cause.cause?.message, native?.message);
    if (native !== undefined) {
      assert.notEqual(error.cause.cause, native);
      assert.equal(error.cause.cause.privateData, undefined);
      assert.equal(error.cause.cause.cause, undefined);
    }
    assert.deepEqual(replies.map((reply) => reply.kind), ["failure", "closed"]);
    assert.equal(worker.terminated, true);
    assert.equal(Atomics.load(control, 3), 1);
  }
});

test("actual GPU setup bounds multibyte diagnostics and marks truncation", async () => {
  const native = new Error("界".repeat(3000));
  native.name = "N".repeat(300);
  const primary = new TabgradError("BACKEND_LOAD_FAILED", "界".repeat(3000), {
    backend: "webgpu", phase: "device-acquisition", reason: "界".repeat(300), privateData: new Float32Array(32),
  }, native);
  const { error, worker } = await acquisitionFailure({ requestAdapter: async () => { throw primary; } });
  assert.equal(error.cause?.code, primary.code);
  assert.equal(error.cause.details.phase, "device-acquisition");
  assert.equal(error.cause.details.diagnosticTruncated, true);
  assert(error.cause.message.length > 0 && error.cause.message.length <= 1024);
  assert(error.cause.cause.message.length > 0 && error.cause.cause.message.length <= 1024);
  assert(error.cause.cause.name.length <= 128);
  assert.equal(error.cause.details.privateData, undefined);
  assert(new TextEncoder().encode(JSON.stringify({ code: error.cause.code, message: error.cause.message,
    details: error.cause.details, cause: { name: error.cause.cause.name, message: error.cause.cause.message } })).byteLength <= 4096);
  assert.equal(worker.terminated, true);
});

test("unreadable GPU setup diagnostic fields cannot replace failure or prevent cleanup", async () => {
  const native = new Error("readable device rejection");
  Object.defineProperty(native, "name", { get() { throw new Error("unreadable native name"); } });
  const primary = new TabgradError("BACKEND_LOAD_FAILED", "readable acquisition failure", {}, native);
  Object.defineProperty(primary, "details", { value: new Proxy({ backend: "webgpu", phase: "device-acquisition" }, {
    get(target, name) { if (name === "reason") throw new Error("unreadable detail"); return target[name]; },
  }) });
  const { error, worker } = await acquisitionFailure({ requestAdapter: async () => { throw primary; } });
  assert.equal(error.cause?.code, primary.code);
  assert.equal(error.cause.message, primary.message);
  assert.equal(error.cause.details.phase, "device-acquisition");
  assert.equal(error.cause.cause.name, "Error");
  assert.equal(error.cause.cause.message, "readable device rejection");
  assert.equal(worker.terminated, true);
});

test("setup diagnostics do not acknowledge physical worker cleanup", async () => {
  const { error, worker, replies, control } = await acquisitionFailure(undefined, true);
  try {
    assert.equal(error.cause?.code, "UNSUPPORTED_DEVICE");
    assert.deepEqual(replies.map((reply) => reply.kind), ["failure", "closed"]);
    assert.equal(worker.terminated, false, "the host must wait for its cleanup acknowledgment");
    worker.dispatchEvent(new Event("error"));
    assert.equal(worker.terminated, true);
    assert.equal(Atomics.load(control, 3), 2, "unacknowledged worker loss remains unknown completion");
  } finally { worker.closed(); }
});

test("malformed setup diagnostics preserve the outer failure and still request cleanup", async () => {
  const restore = workerEnvironment();
  let worker;
  try {
    const setup = python.createWebGpuWorker();
    worker = ControlledWorker.instances[0];
    worker.dispatchEvent(new MessageEvent("message", { data: { kind: "failure", diagnostic: new Uint8Array([123]) } }));
    await assert.rejects(setup, (error) => error.code === "BACKEND_LOAD_FAILED"
      && error.cause?.code === "BACKEND_STATUS_ERROR");
    assert.equal(worker.terminated, false);
    assert.equal(worker.messages.at(-1).message.kind, "close");
  } finally { worker?.closed(); restore(); }
});

test("the GPU helper rejects insecure or nonisolated hosting before creating a worker", async () => {
  let workers = 0;
  class ForbiddenWorker { constructor() { workers += 1; } }
  for (const [secure, isolated] of [[false, true], [true, false]]) {
    const restore = environment({ isSecureContext: secure, crossOriginIsolated: isolated, Worker: ForbiddenWorker });
    try {
      await assert.rejects(python.createWebGpuWorker(), (error) => error.code === "UNSUPPORTED_DEVICE");
      assert.equal(workers, 0);
    } finally { restore(); }
  }
});

test("an already revoked helper never acquires a worker", async () => {
  let workers = 0;
  class ForbiddenWorker { constructor() { workers += 1; } }
  const restore = environment({ isSecureContext: true, crossOriginIsolated: true, Worker: ForbiddenWorker });
  const abort = new AbortController();
  abort.abort(new Error("host lifetime ended"));
  try {
    await assert.rejects(python.createWebGpuWorker({ signal: abort.signal }), (error) => error.code === "BACKEND_LOAD_FAILED");
    assert.equal(workers, 0);
  } finally { restore(); }
});

test("the ready controller owns one transferable connection and close joins cleanup", async () => {
  const restore = workerEnvironment();
  const url = new URL("https://example.invalid/assets/webgpu-worker.js");
  try {
    const setup = python.createWebGpuWorker({ workerUrl: url });
    const worker = ControlledWorker.instances[0];
    assert.equal(worker.url, url);
    assert.equal(worker.options.type, "module");
    worker.ready();
    const controller = await setup;
    assert.equal(ControlledWorker.instances.length, 1);
    assert.equal(controller.transferables.length, 2);
    const transferred = structuredClone(controller.connection, { transfer: [...controller.transferables] });
    assert(transferred.port instanceof MessagePort);
    assert(transferred.supervision instanceof MessagePort);
    assert(transferred.control instanceof SharedArrayBuffer);
    const close = controller.close();
    assert.equal(controller.close(), close);
    assert.equal(worker.terminated, false);
    assert.equal(worker.messages.at(-1).message.kind, "close");
    worker.closed();
    await close;
    assert.equal(worker.terminated, true);
    transferred.port.close();
    transferred.supervision.close();
  } finally { restore(); }
});

test("the default GPU worker URL resolves to the distribution-root startup entry", async () => {
  const restore = workerEnvironment();
  try {
    const setup = python.createWebGpuWorker();
    const worker = ControlledWorker.instances[0];
    assert.equal(worker.url.href, new URL("../../../dist/webgpu-worker.js", import.meta.url).href);
    assert.equal(worker.options.type, "module");
    worker.ready();
    const controller = await setup;
    const close = controller.close();
    worker.closed();
    await close;
  } finally { restore(); }
});

test("public API imports do not start the GPU service and its packaged entry starts once", () => {
  const entries = ["index.js", "python.js", "webgpu-worker.js"].map(
    (name) => new URL(`../../../dist/${name}`, import.meta.url).href,
  );
  const program = `
    import assert from "node:assert/strict";
    const [runtime, python, worker] = ${JSON.stringify(entries)};
    const listeners = [];
    globalThis.addEventListener = (type, listener) => {
      assert.equal(type, "message");
      assert.equal(typeof listener, "function");
      listeners.push(listener);
    };
    globalThis.Worker = class {
      constructor() { assert.fail("Importing API entries must not construct a worker."); }
    };
    await import(runtime);
    await import(python);
    assert.equal(listeners.length, 0);
    const first = await import(worker);
    assert.equal(listeners.length, 1);
    assert.equal(await import(worker), first);
    assert.equal(listeners.length, 1);
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", program], { stdio: "pipe" });
});

test("readiness transports capabilities rather than a frontend-specific support list", async () => {
  const restore = workerEnvironment();
  try {
    const setup = python.createWebGpuWorker();
    const worker = ControlledWorker.instances[0];
    worker.ready({ ...capabilities, gradients: true, computations: ["future-computation"] });
    const controller = await setup;
    assert.equal(controller.connection.capabilities.gradients, true);
    assert.deepEqual(controller.connection.capabilities.computations, ["future-computation"]);
    const identity = controller.connection;
    worker.ready();
    assert.equal(controller.connection, identity, "a duplicate readiness hint cannot replace the issued connection");
    const cleanup = controller.close();
    worker.closed();
    await cleanup;
  } finally { restore(); }
});

test("malformed capability extents and computation identifiers are rejected before readiness", async () => {
  const restore = workerEnvironment();
  try {
    for (const change of [{ maximumTensorBytes: NaN }, { maximumTensorBytes: -1 }, { computations: [null] }]) {
      const setup = python.createWebGpuWorker();
      const worker = ControlledWorker.instances.at(-1);
      worker.ready({ ...capabilities, ...change });
      await assert.rejects(setup, { code: "BACKEND_LOAD_FAILED" });
      worker.closed();
      assert.equal(worker.terminated, true);
    }
  } finally { restore(); }
});

test("setup cancellation rejects promptly but retains the worker until late cleanup", async () => {
  const restore = workerEnvironment();
  const abort = new AbortController();
  try {
    const setup = python.createWebGpuWorker({ signal: abort.signal });
    const worker = ControlledWorker.instances[0];
    abort.abort();
    await assert.rejects(setup, (error) => error.code === "BACKEND_LOAD_FAILED");
    assert.equal(worker.terminated, false);
    assert.equal(worker.messages.at(-1).message.kind, "close");
    worker.ready();
    assert.equal(worker.terminated, false);
    worker.closed();
    assert.equal(worker.terminated, true);
  } finally { restore(); }
});

test("lifetime abort revokes the shared generation and wakes independently", async () => {
  const restore = workerEnvironment();
  const abort = new AbortController();
  try {
    const setup = python.createWebGpuWorker({ signal: abort.signal });
    const worker = ControlledWorker.instances[0];
    worker.ready();
    const controller = await setup;
    const control = new Int32Array(controller.connection.control);
    assert.equal(Atomics.load(control, 0), 0);
    abort.abort();
    assert.equal(Atomics.load(control, 0), 1);
    assert(Atomics.load(control, 2) > 0);
    assert.equal(worker.terminated, false);
    worker.closed();
    await controller.close();
  } finally { restore(); }
});

test("worker construction failure closes both locally owned channel endpoints", async () => {
  const NativeChannel = MessageChannel;
  let closed = 0;
  const channels = [];
  class TrackedChannel {
    constructor() {
      const channel = new NativeChannel();
      channels.push(channel);
      for (const port of [channel.port1, channel.port2]) {
        const close = port.close.bind(port);
        port.close = () => { closed += 1; close(); };
      }
      return channel;
    }
  }
  const failure = new Error("worker denied by CSP");
  class DeniedWorker { constructor() { throw failure; } }
  const restore = environment({ isSecureContext: true, crossOriginIsolated: true, Worker: DeniedWorker, MessageChannel: TrackedChannel });
  try {
    await assert.rejects(python.createWebGpuWorker(), (error) => error === failure);
    assert.equal(closed, channels.length * 2);
  } finally {
    for (const channel of channels) { channel.port1.close(); channel.port2.close(); }
    restore();
  }
});

test("an observed worker error revokes observers but close does not claim successful drain", async () => {
  const restore = workerEnvironment();
  try {
    const setup = python.createWebGpuWorker();
    const worker = ControlledWorker.instances[0];
    worker.ready();
    const controller = await setup;
    const control = new Int32Array(controller.connection.control);
    worker.dispatchEvent(new Event("error"));
    assert.equal(Atomics.load(control, 0), 1);
    assert.equal(worker.terminated, true);
    await assert.rejects(controller.close(), (error) => error.details.physicalCompletion === "unknown");
  } finally { restore(); }
});

test("cleanup without readiness cannot leave the factory pending", async () => {
  const restore = workerEnvironment();
  try {
    const setup = python.createWebGpuWorker();
    const worker = ControlledWorker.instances[0];
    worker.closed();
    await assert.rejects(setup, (error) => error.code === "BACKEND_LOAD_FAILED");
  } finally { restore(); }
});

test("failed attachment retires its consumed connection rather than leaving ready GPU ownership", async () => {
  const restore = workerEnvironment();
  try {
    const setup = python.createWebGpuWorker();
    const worker = ControlledWorker.instances[0];
    worker.ready();
    const controller = await setup;
    const connection = structuredClone(controller.connection, { transfer: [...controller.transferables] });
    const control = new Int32Array(connection.control);
    await assert.rejects(python.attachPython({ version: "unsupported" }, { webgpu: connection }), {
      code: "UNSUPPORTED_PYODIDE",
    });
    assert.equal(Atomics.load(control, 1), 1);
    assert.equal(Atomics.load(control, 0), 1);
    await assert.rejects(python.attachPython({ version: "unsupported" }, { webgpu: connection }), {
      code: "PYTHON_CONNECTION_IN_USE",
    });
    const close = controller.close();
    worker.closed();
    await close;
    connection.port.close();
  } finally { restore(); }
});
