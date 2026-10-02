import assert from "node:assert/strict";
import { test } from "node:test";
import { ExecutionRequest } from "../../dist/execution-request.js";
import { ExecutionTicket } from "../../dist/execution-ticket.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onSuccess, onFailure) => {
    resolve = onSuccess;
    reject = onFailure;
  });
  return { promise, resolve, reject };
}

function invocation(steps) {
  const counts = { published: 0, retired: 0 };
  const request = new ExecutionRequest(
    steps,
    () => request.advance(),
    () => { counts.published += 1; },
    () => { counts.retired += 1; },
  );
  request.advance();
  return { request, counts };
}

test("asynchronous results resume the same generator with their value", async () => {
  const result = deferred();
  const drained = deferred();
  const { request, counts } = invocation((function* () {
    return (yield new ExecutionTicket(result.promise, drained.promise)) + 1;
  })());
  const observation = request.asPromise();
  result.resolve(40);
  assert.equal(await observation, 41);
  assert.deepEqual(counts, { published: 1, retired: 0 });
  drained.resolve();
  await drained.promise;
  await Promise.resolve();
  assert.equal(counts.retired, 1);
});

test("a synchronous observer consumes shared completion before local callbacks run", async () => {
  const result = deferred();
  const drained = deferred();
  let reads = 0;
  let continuations = 0;
  const ticket = new ExecutionTicket(result.promise, drained.promise, {
    read() { reads += 1; return 40; },
    isDrained() { return true; },
  });
  const { request, counts } = invocation((function* () {
    const value = yield ticket;
    continuations += 1;
    return value + 2;
  })());
  const observation = request.asPromise();
  assert.equal(request.read(), 42);
  assert.equal(reads, 1);
  assert.equal(continuations, 1);
  assert.deepEqual(counts, { published: 1, retired: 1 });
  assert.equal(await observation, 42);
  result.resolve(900);
  drained.resolve();
  await Promise.resolve();
  assert.equal(request.read(), 42);
  assert.equal(continuations, 1);
  assert.deepEqual(counts, { published: 1, retired: 1 });
});

test("a stale callback cannot resume the next shared step", async () => {
  const first = deferred();
  const second = deferred();
  let firstReads = 0;
  let secondReads = 0;
  const firstTicket = new ExecutionTicket(first.promise, Promise.resolve(), {
    read() { firstReads += 1; return 3; },
    isDrained() { return true; },
  });
  const secondTicket = new ExecutionTicket(second.promise, Promise.resolve(), {
    read() { secondReads += 1; return 7; },
    isDrained() { return true; },
  });
  const { request, counts } = invocation((function* () {
    const left = yield firstTicket;
    const right = yield secondTicket;
    return left * right;
  })());
  assert.equal(request.read(), 21);
  first.resolve(100);
  second.resolve(200);
  await Promise.resolve();
  assert.equal(request.read(), 21);
  assert.equal(firstReads, 1);
  assert.equal(secondReads, 1);
  assert.deepEqual(counts, { published: 1, retired: 1 });
});

test("shared failure publishes once but keeps pins until physical drain", async () => {
  const result = deferred();
  const drained = deferred();
  const failure = new Error("independent worker loss");
  const { request, counts } = invocation((function* () {
    yield new ExecutionTicket(result.promise, drained.promise, {
      read() { throw failure; },
      isDrained() { return false; },
    });
    assert.fail("failed work must not continue");
  })());
  const observation = request.asPromise();
  const rejection = assert.rejects(observation, (error) => error === failure);
  assert.throws(() => request.read(), (error) => error === failure);
  assert.deepEqual(counts, { published: 1, retired: 0 });
  await rejection;
  result.reject(failure);
  drained.resolve();
  await drained.promise;
  await Promise.resolve();
  assert.deepEqual(counts, { published: 1, retired: 1 });
});

test("already-ready asynchronous completion is not consumed a second time", async () => {
  let reads = 0;
  const { request, counts } = invocation((function* () {
    return yield new ExecutionTicket(Promise.resolve(11), Promise.resolve(), {
      read() { reads += 1; return 11; },
      isDrained() { return true; },
    });
  })());
  assert.equal(await request.asPromise(), 11);
  assert.equal(request.read(), 11);
  assert.equal(reads, 0);
  assert.deepEqual(counts, { published: 1, retired: 1 });
});

test("a local Promise-only step cannot be synchronously waited", async () => {
  const result = deferred();
  const { request, counts } = invocation((function* () {
    yield result.promise;
    return 5;
  })());
  assert.throws(() => request.read(), /terminal result/);
  assert.deepEqual(counts, { published: 0, retired: 0 });
  result.resolve();
  assert.equal(await request.asPromise(), 5);
});

test("ordinary synchronous consumption does not enqueue unused Promise reactions", () => {
  let subscriptions = 0;
  class ObservedPromise extends Promise {
    then(...arguments_) { subscriptions += 1; return super.then(...arguments_); }
  }
  const result = new ObservedPromise((resolve) => resolve(41));
  const { request, counts } = invocation((function* () {
    return (yield new ExecutionTicket(result, Promise.resolve(), {
      read() { return 41; },
      isDrained() { return true; },
    })) + 1;
  })());
  assert.equal(request.read(), 42);
  assert.equal(subscriptions, 0);
  assert.deepEqual(counts, { published: 1, retired: 1 });
});

test("ticket Promise factories are invoked only on observation and share one result", async () => {
  let results = 0;
  let drains = 0;
  const ticket = new ExecutionTicket(
    () => { results += 1; return Promise.resolve(17); },
    () => { drains += 1; return Promise.resolve(); },
  );
  assert.equal(results, 0);
  assert.equal(drains, 0);
  assert.equal(await ticket.result, 17);
  assert.equal(ticket.result, ticket.result);
  assert.equal(results, 1);
  assert.equal(drains, 0);
  await ticket.drained;
  assert.equal(ticket.drained, ticket.drained);
  assert.equal(drains, 1);
});
