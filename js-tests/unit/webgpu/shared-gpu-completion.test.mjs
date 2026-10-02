import assert from "node:assert/strict";
import { once } from "node:events";
import { createHook } from "node:async_hooks";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { TabgradError } from "../../../dist/shared/errors.js";
import { ExecutionRequest } from "../../../dist/runtime/execution-request.js";
import { GPU_CONTROL_LENGTH, retireGpuConnection } from "../../../dist/backends/webgpu/webgpu-connection.js";
import { SharedGpuCompletion, publishSharedGpuFailure, publishSharedGpuSuccess, publishSharedGpuDrain } from "../../../dist/backends/webgpu/webgpu-shared-completion.js";

function completion(control, bytes = 4) {
  let retired = 0;
  const shared = new SharedGpuCompletion(control, bytes,
    (payload) => new Float32Array(payload.buffer, payload.byteOffset, payload.byteLength / 4).slice(),
    () => { retired += 1; });
  return { shared, retired: () => retired };
}

test("early shared publication is readable and retires without local Promise callbacks", () => {
  const control = new Int32Array(new SharedArrayBuffer(GPU_CONTROL_LENGTH * 4));
  const { shared, retired } = completion(control);
  const data = new Float32Array([42]);
  publishSharedGpuSuccess(shared.buffer, control, new Uint8Array(data.buffer));
  assert.deepEqual([...shared.read()], [42]);
  assert.equal(shared.isDrained(), true);
  shared.refresh();
  assert.equal(retired(), 1);
});

test("a real independent worker advances a parked request and delayed callbacks cannot repeat it", async () => {
  const control = new Int32Array(new SharedArrayBuffer(GPU_CONTROL_LENGTH * 4));
  const { shared, retired } = completion(control);
  const thread = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.module).then(({ publishSharedGpuSuccess }) => {
      parentPort.on('message', () => {
        const value = new Float32Array([41]);
        publishSharedGpuSuccess(workerData.buffer, new Int32Array(workerData.control), new Uint8Array(value.buffer));
        parentPort.postMessage('published');
      });
      parentPort.postMessage('ready');
    });
  `, { eval: true, workerData: { module: new URL("../../../dist/backends/webgpu/webgpu-shared-completion.js", import.meta.url).href,
    buffer: shared.buffer, control: control.buffer } });
  let published = 0;
  let requestRetired = 0;
  let resumed = 0;
  const request = new ExecutionRequest((function* () {
    const value = yield shared.ticket;
    resumed += 1;
    return value[0] + 1;
  })(), () => request.advance(), () => { published += 1; }, () => { requestRetired += 1; });
  try {
    await once(thread, "message");
    request.advance();
    const observation = request.asPromise();
    thread.postMessage("publish");
    assert.equal(request.read(), 42);
    assert.equal(resumed, 1);
    assert.equal(published, 1);
    assert.equal(requestRetired, 1);
    assert.equal(retired(), 1);
    assert.equal(await observation, 42);
    assert.equal(resumed, 1);
  } finally { await thread.terminate(); }
});

test("failure and physical drain remain independent shared facts", async () => {
  const control = new Int32Array(new SharedArrayBuffer(GPU_CONTROL_LENGTH * 4));
  const { shared, retired } = completion(control);
  publishSharedGpuFailure(shared.buffer, control, new TabgradError("BACKEND_STATUS_ERROR", "mapping failed", {
    phase: "readback", programValueSlot: 4,
  }));
  assert.throws(() => shared.read(), (error) => error.code === "BACKEND_STATUS_ERROR"
    && error.details.phase === "readback" && error.details.programValueSlot === 4);
  assert.equal(shared.isDrained(), false);
  assert.equal(retired(), 0);
  publishSharedGpuDrain(shared.buffer, control);
  shared.refresh();
  await shared.ticket.drained;
  assert.equal(retired(), 1);
});

test("retirement rejects a stale successful publication without claiming drain", () => {
  const control = new Int32Array(new SharedArrayBuffer(GPU_CONTROL_LENGTH * 4));
  const { shared, retired } = completion(control);
  retireGpuConnection(control);
  const data = new Float32Array([1]);
  assert.throws(() => publishSharedGpuSuccess(shared.buffer, control, new Uint8Array(data.buffer)), { code: "BACKEND_STATUS_ERROR" });
  assert.throws(() => shared.read(), { code: "BACKEND_STATUS_ERROR" });
  assert.equal(shared.isDrained(), false);
  assert.equal(retired(), 0);
});

test("long multibyte diagnostics must still publish a terminal failure", () => {
  const control = new Int32Array(new SharedArrayBuffer(GPU_CONTROL_LENGTH * 4));
  const { shared } = completion(control);
  const message = "界".repeat(2000);
  publishSharedGpuFailure(shared.buffer, control, new TabgradError("BACKEND_STATUS_ERROR", message, {
    phase: "界".repeat(256), reason: "界".repeat(256), backend: "webgpu", programValueSlot: 7,
  }));
  assert.throws(() => shared.read(), (error) => error.code === "BACKEND_STATUS_ERROR"
    && error.details.programValueSlot === 7 && error.details.diagnosticTruncated === true);
});

test("physical validation failures preserve bounded native cause diagnostics, not live objects", () => {
  const control = new Int32Array(new SharedArrayBuffer(GPU_CONTROL_LENGTH * 4));
  const { shared } = completion(control);
  const cause = new Error("Binding size exceeds the declared storage buffer limit.");
  cause.name = "GPUValidationError";
  cause.tensor = { data: new Float32Array(65536) };
  cause.cause = cause;
  publishSharedGpuFailure(shared.buffer, control, new TabgradError("BACKEND_STATUS_ERROR", "WebGPU execution failed.", {
    phase: "execution", programValueSlot: 3,
  }, cause));
  assert.throws(() => shared.read(), (error) => {
    assert.equal(error.details.phase, "execution");
    assert.equal(error.details.programValueSlot, 3);
    assert.equal(error.cause?.name, "GPUValidationError");
    assert.equal(error.cause?.message, cause.message);
    assert.notEqual(error.cause, cause);
    assert.equal(error.cause.cause, undefined);
    assert.equal(error.cause.tensor, undefined);
    assert.equal(error.details.diagnosticTruncated, false);
    return true;
  });
});

test("native cause and scalar detail truncation respect the shared UTF-8 capacity", () => {
  const control = new Int32Array(new SharedArrayBuffer(GPU_CONTROL_LENGTH * 4));
  const { shared } = completion(control);
  const cause = new Error("界".repeat(3000));
  cause.name = "GPUValidationError";
  publishSharedGpuFailure(shared.buffer, control, new TabgradError("BACKEND_STATUS_ERROR", "execution failed", {
    backend: "webgpu", phase: "execution", reason: "界".repeat(300), programValueSlot: 3,
  }, cause));
  assert.throws(() => shared.read(), (error) => {
    assert.equal(error.cause?.name, "GPUValidationError");
    assert(error.cause?.message.length > 0 && error.cause.message.length < cause.message.length);
    assert.equal(error.details.diagnosticTruncated, true);
    assert.equal(error.details.programValueSlot, 3);
    return true;
  });
});

test("an unobserved synchronous completion allocates no Promise or queued reaction", () => {
  const control = new Int32Array(new SharedArrayBuffer(GPU_CONTROL_LENGTH * 4));
  let promises = 0;
  const hook = createHook({ init(_id, type) { if (type === "PROMISE") promises += 1; } });
  hook.enable();
  try {
    const { shared } = completion(control);
    publishSharedGpuSuccess(shared.buffer, control, new Uint8Array(new Float32Array([3]).buffer));
    assert.deepEqual([...shared.read()], [3]);
  } finally { hook.disable(); }
  assert.equal(promises, 0);
});

test("caught failure releases request pins synchronously after delayed physical drain", () => {
  const control = new Int32Array(new SharedArrayBuffer(GPU_CONTROL_LENGTH * 4));
  const { shared, retired } = completion(control);
  let requestRetired = 0;
  const request = new ExecutionRequest((function* () {
    return yield shared.ticket;
  })(), () => request.advance(), () => undefined, () => { requestRetired += 1; });
  request.advance();
  publishSharedGpuFailure(shared.buffer, control, new TabgradError("BACKEND_STATUS_ERROR", "readback failed"));
  assert.throws(() => request.read(), { code: "BACKEND_STATUS_ERROR" });
  assert.equal(requestRetired, 0, "logical failure cannot release physical pins");
  assert.equal(retired(), 0);
  publishSharedGpuDrain(shared.buffer, control);
  shared.refresh();
  assert.equal(retired(), 1);
  assert.equal(requestRetired, 1, "physical accounting must not depend on a local Promise reaction");
  shared.refresh();
  assert.equal(requestRetired, 1);
});

test("multiple failed tickets drain out of order with exactly-once reentrant retirement", () => {
  const control = new Int32Array(new SharedArrayBuffer(GPU_CONTROL_LENGTH * 4));
  const first = completion(control);
  const second = completion(control);
  const error = new TabgradError("BACKEND_STATUS_ERROR", "failed physical work");
  publishSharedGpuFailure(first.shared.buffer, control, error);
  publishSharedGpuFailure(second.shared.buffer, control, error);
  let retired = 0;
  const request = new ExecutionRequest((function* () {
    try { yield first.shared.ticket; } catch { /* The accepted generator continues. */ }
    yield second.shared.ticket;
  })(), () => request.advance(), () => undefined, () => {
    retired += 1;
    first.shared.refresh();
    second.shared.refresh();
  });
  request.advance();
  assert.throws(() => request.read(), { code: "BACKEND_STATUS_ERROR" });
  publishSharedGpuDrain(second.shared.buffer, control);
  second.shared.refresh();
  assert.equal(retired, 0);
  assert.equal(first.retired(), 0);
  assert.equal(second.retired(), 1);
  publishSharedGpuDrain(first.shared.buffer, control);
  first.shared.refresh();
  assert.equal(retired, 1);
  first.shared.refresh(); second.shared.refresh();
  assert.equal(retired, 1);
  assert.equal(first.retired(), 1);
  assert.equal(second.retired(), 1);
});
