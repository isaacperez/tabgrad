import assert from "node:assert/strict";
import { test } from "node:test";
import { getEventListeners } from "node:events";
import * as python from "../../dist/python.js";
import { TabgradError, retainExecutionFailureContext } from "../../dist/errors.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((success, failure) => { resolve = success; reject = failure; });
  return { promise, resolve, reject };
}

test("worker host reserves before dispatch and joins the accepted script on close", {
  timeout: 5000,
}, async (context) => {
  const channel = new MessageChannel();
  context.after(() => { channel.port1.close(); channel.port2.close(); });
  const entered = deferred();
  const finish = deferred();
  const calls = [];
  const binding = {
    async runPythonAsync(source) {
      calls.push(source);
      entered.resolve();
      await finish.promise;
    },
    async close() { calls.push("closed"); },
  };
  const client = python.connectPythonWorker(channel.port1);
  const running = client.runPythonAsync("accepted");
  await assert.rejects(client.runPythonAsync("overlap"), { code: "PYTHON_ENTRY_BUSY" });
  const closing = client.close();
  assert.equal(client.close(), closing);
  await assert.rejects(client.runPythonAsync("after close"), { code: "CLOSED_PYTHON_BINDING" });
  // Starting the receiver later proves admission does not need its event loop.
  const serving = python.servePythonWorker(binding, channel.port2);
  await entered.promise;
  assert.deepEqual(calls, ["accepted"]);
  let closed = false;
  void closing.then(() => { closed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  finish.resolve();
  assert.equal(await running, undefined);
  await closing;
  await serving;
  assert.deepEqual(calls, ["accepted", "closed"]);
});

test("worker entry failure retains diagnostic cause and does not become close failure", {
  timeout: 5000,
}, async (context) => {
  const channel = new MessageChannel();
  context.after(() => { channel.port1.close(); channel.port2.close(); });
  const cause = new WebAssembly.RuntimeError("controlled kernel trap");
  const failure = new TabgradError("BACKEND_TRAP", "kernel failed", {
    phase: "execution", operation: "add-f32", programValueSlot: 2,
  }, cause);
  retainExecutionFailureContext(failure, {
    operation: "add", programValueSlot: 2,
    provenance: { operation: "add", source: "Tensor.add" },
    program: { values: [] }, executionDomain: "cpu", backendEndpoints: ["webassembly-cpu"],
    phase: "execution",
  });
  let runs = 0;
  let closes = 0;
  const serving = python.servePythonWorker({
    async runPythonAsync() { if (++runs === 1) throw failure; },
    async close() { closes += 1; },
  }, channel.port2);
  const client = python.connectPythonWorker(channel.port1);
  await assert.rejects(client.runPythonAsync("failing"), (error) => {
    assert.equal(error.name, "TabgradError");
    assert.equal(error.code, "BACKEND_TRAP");
    assert.deepEqual(error.details, failure.details);
    assert.equal(error.cause.name, "RuntimeError");
    assert.equal(error.cause.message, cause.message);
    assert.equal(error.executionContext.operation, "add");
    assert.equal(error.executionContext.provenance.source, "Tensor.add");
    assert.equal("program" in error.executionContext, false);
    return true;
  });
  await client.runPythonAsync("next");
  await client.close();
  await serving;
  assert.equal(runs, 2);
  assert.equal(closes, 1);
});

test("host-reported connection loss rejects outstanding entry and cannot acknowledge drain", {
  timeout: 5000,
}, async (context) => {
  const channel = new MessageChannel();
  context.after(() => { channel.port1.close(); channel.port2.close(); });
  const controller = new AbortController();
  const client = python.connectPythonWorker(channel.port1, controller.signal);
  const running = client.runPythonAsync("no receiver");
  const closing = client.close();
  const runFailure = assert.rejects(running, { code: "PYTHON_CONNECTION_LOST" });
  const closeFailure = assert.rejects(closing, { code: "PYTHON_CONNECTION_LOST" });
  controller.abort(new Error("host terminated its worker"));
  await runFailure;
  await closeFailure;
  assert.equal(client.close(), closing);
  await assert.rejects(client.runPythonAsync("late"), { code: "CLOSED_PYTHON_BINDING" });
});

test("unmatched replies fail the connection instead of settling another invocation", {
  timeout: 5000,
}, async (context) => {
  const channel = new MessageChannel();
  context.after(() => { channel.port1.close(); channel.port2.close(); });
  const client = python.connectPythonWorker(channel.port1);
  const running = client.runPythonAsync("accepted");
  const rejection = assert.rejects(running, { code: "PYTHON_CONNECTION_LOST" });
  channel.port2.postMessage({ id: 99, ok: true });
  await rejection;
  await assert.rejects(client.close(), { code: "PYTHON_CONNECTION_LOST" });
});

test("a synchronous binding rejection releases worker admission for the next entry", {
  timeout: 5000,
}, async (context) => {
  const channel = new MessageChannel();
  const controller = new AbortController();
  context.after(() => controller.abort("test cleanup"));
  context.after(() => { channel.port1.close(); channel.port2.close(); });
  let runs = 0;
  const serving = python.servePythonWorker({
    runPythonAsync() { if (++runs === 1) throw new TypeError("invalid entry"); return Promise.resolve(); },
    async close() {},
  }, channel.port2);
  // Observe service failure immediately so a protocol defect is not an unhandled rejection.
  const outcome = serving.then(() => undefined, (error) => error);
  const client = python.connectPythonWorker(channel.port1, controller.signal);
  await assert.rejects(client.runPythonAsync("first"), { name: "TypeError" });
  await Promise.race([
    client.runPythonAsync("second"),
    outcome.then((error) => { if (error !== undefined) throw error; }),
  ]);
  await client.close();
  assert.equal(await outcome, undefined);
});

test("failure sending the close acknowledgment is not a successful service completion", {
  timeout: 5000,
}, async (context) => {
  const channel = new MessageChannel();
  context.after(() => { channel.port1.close(); channel.port2.close(); });
  const controller = new AbortController();
  const nativeSend = channel.port2.postMessage.bind(channel.port2);
  let closing = false;
  context.mock.method(channel.port2, "postMessage", (message) => {
    if (closing) throw new Error("controlled send failure");
    nativeSend(message);
  });
  const serving = python.servePythonWorker({
    async runPythonAsync() {},
    async close() { closing = true; },
  }, channel.port2);
  const outcome = serving.then(() => undefined, (error) => error);
  const client = python.connectPythonWorker(channel.port1, controller.signal);
  await client.runPythonAsync("pass");
  const closed = client.close();
  const rejection = assert.rejects(closed, { code: "PYTHON_CONNECTION_LOST" });
  const failure = await outcome;
  controller.abort(failure);
  await rejection;
  assert.equal(failure?.code, "PYTHON_CONNECTION_LOST");
});

test("local connection loss while cleanup is pending cannot report successful closure", {
  timeout: 5000,
}, async (context) => {
  const channel = new MessageChannel();
  context.after(() => { channel.port1.close(); channel.port2.close(); });
  const hostLoss = new AbortController();
  const workerLoss = new AbortController();
  const entered = deferred();
  const drain = deferred();
  const serving = python.servePythonWorker({
    async runPythonAsync() {},
    async close() { entered.resolve(); await drain.promise; },
  }, channel.port2, workerLoss.signal);
  const outcome = serving.then(() => undefined, (error) => error);
  const client = python.connectPythonWorker(channel.port1, hostLoss.signal);
  const closed = client.close();
  const rejected = assert.rejects(closed, { code: "PYTHON_CONNECTION_LOST" });
  await entered.promise;
  workerLoss.abort("connection failed");
  hostLoss.abort("connection failed");
  drain.resolve();
  await rejected;
  assert.equal((await outcome)?.code, "PYTHON_CONNECTION_LOST");
});

test("genuine cleanup rejection retains aggregate diagnostics and releases both endpoints", {
  timeout: 5000,
}, async (context) => {
  const channel = new MessageChannel();
  context.after(() => { channel.port1.close(); channel.port2.close(); });
  const hostLoss = new AbortController();
  const workerLoss = new AbortController();
  const hostClose = context.mock.method(channel.port1, "close");
  const workerClose = context.mock.method(channel.port2, "close");
  const nativeCause = new Error("controlled native cleanup failure");
  nativeCause.cause = nativeCause;
  const cleanup = new AggregateError([
    new TabgradError("BACKEND_STATUS_ERROR", "runtime cleanup failed", { phase: "cleanup" }, nativeCause),
    new Error("installation cleanup failed"),
  ], "both cleanup owners failed");
  const serving = python.servePythonWorker({
    async runPythonAsync() { throw new Error("separate script failure"); },
    async close() { throw cleanup; },
  }, channel.port2, workerLoss.signal);
  const serviceRejection = assert.rejects(serving, (error) => error === cleanup);
  const client = python.connectPythonWorker(channel.port1, hostLoss.signal);
  assert.equal(getEventListeners(channel.port1, "message").length, 1);
  assert.equal(getEventListeners(channel.port2, "message").length, 1);
  await assert.rejects(client.runPythonAsync("fail"), { message: "separate script failure" });
  const closing = client.close();
  assert.equal(client.close(), closing);
  await assert.rejects(closing, (error) => {
    assert.ok(error instanceof python.PythonWorkerError);
    assert.equal(error.name, "AggregateError");
    assert.equal(error.message, "both cleanup owners failed");
    assert.equal(error.errors.length, 2);
    assert.equal(error.errors[0].code, "BACKEND_STATUS_ERROR");
    assert.deepEqual(error.errors[0].details, { phase: "cleanup" });
    assert.equal(error.errors[0].cause.message, nativeCause.message);
    assert.equal(error.errors[0].cause.cause, error.errors[0].cause);
    assert.equal(error.errors[1].message, "installation cleanup failed");
    return true;
  });
  await serviceRejection;
  for (const port of [channel.port1, channel.port2]) {
    assert.equal(getEventListeners(port, "message").length, 0);
    assert.equal(getEventListeners(port, "messageerror").length, 0);
  }
  assert.equal(getEventListeners(hostLoss.signal, "abort").length, 0);
  assert.equal(getEventListeners(workerLoss.signal, "abort").length, 0);
  assert.equal(hostClose.mock.calls.length, 1);
  assert.equal(workerClose.mock.calls.length, 1);
});

test("ports have one lifetime owner and a live binding has one service", {
  timeout: 5000,
}, async (context) => {
  const channel = new MessageChannel();
  const other = new MessageChannel();
  context.after(() => {
    for (const port of [channel.port1, channel.port2, other.port1, other.port2]) port.close();
  });
  const binding = { async runPythonAsync() {}, async close() {} };
  const serving = python.servePythonWorker(binding, channel.port2);
  assert.throws(() => python.servePythonWorker(binding, other.port2), { code: "PYTHON_CONNECTION_IN_USE" });
  assert.throws(() => python.connectPythonWorker(channel.port2), { code: "PYTHON_CONNECTION_IN_USE" });
  const client = python.connectPythonWorker(channel.port1);
  assert.throws(() => python.connectPythonWorker(channel.port1), { code: "PYTHON_CONNECTION_IN_USE" });
  await client.runPythonAsync("pass");
  await client.close();
  await serving;
  for (const port of [channel.port1, channel.port2]) {
    assert.equal(getEventListeners(port, "message").length, 0);
    assert.equal(getEventListeners(port, "messageerror").length, 0);
    assert.throws(() => python.connectPythonWorker(port), { code: "PYTHON_CONNECTION_IN_USE" });
  }
  // Rejecting a duplicate binding did not consume the unrelated candidate port.
  const replacement = { async runPythonAsync() {}, async close() {} };
  const nextService = python.servePythonWorker(replacement, other.port2);
  const nextClient = python.connectPythonWorker(other.port1);
  await nextClient.close();
  await nextService;
});

test("malformed error data with the right sequence cannot masquerade as a remote failure", {
  timeout: 5000,
}, async (context) => {
  const channel = new MessageChannel();
  context.after(() => { channel.port1.close(); channel.port2.close(); });
  const client = python.connectPythonWorker(channel.port1);
  const running = client.runPythonAsync("accepted");
  const rejection = assert.rejects(running, { code: "PYTHON_CONNECTION_LOST" });
  channel.port2.postMessage({ id: 1, ok: false, error: { name: "Error", message: 42 } });
  await rejection;
  await assert.rejects(client.close(), { code: "PYTHON_CONNECTION_LOST" });
  assert.equal(getEventListeners(channel.port1, "message").length, 0);
});
