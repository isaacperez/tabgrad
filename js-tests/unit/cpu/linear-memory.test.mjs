import assert from "node:assert/strict";
import { test } from "node:test";
import { LinearMemoryAllocator } from "../../../dist/backends/cpu/linear-memory.js";

for (const releaseOrder of [[1, 3, 5], [5, 3, 1], [3, 1, 5]]) {
  test(`CPU fragmented reuse keeps lowest-address first fit: ${releaseOrder}`, () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1 });
    const allocator = new LinearMemoryAllocator(memory, 49, 1, 16, 7);
    const blocks = [4, 20, 4, 36, 4, 20, 4].map(bytes => allocator.allocate(bytes));
    for (let index = 0; index < blocks.length; index++) {
      new Uint32Array(memory.buffer, blocks[index].offset, 1)[0] = index + 1;
      assert.equal(blocks[index].offset % 16, 0);
    }
    for (const index of releaseOrder) allocator.release(blocks[index]);
    const reused = [16, 20, 16, 20].map(bytes => allocator.allocate(bytes));
    assert.deepEqual(reused.map(block => block.offset), [
      blocks[1].offset, blocks[3].offset, blocks[1].offset + 16, blocks[5].offset,
    ]);
    for (const index of [0, 2, 4, 6]) {
      assert.equal(new Uint32Array(memory.buffer, blocks[index].offset, 1)[0], index + 1);
    }
    for (const block of [...blocks, ...reused]) allocator.release(block);
    assert.equal(allocator.livePayloadBytes, 0);
    assert.equal(allocator.liveReservedBytes, 0);
  });
}

for (const releaseOrder of [[1, 3, 2], [3, 1, 2], [2, 3, 1]]) {
  test(`CPU release coalesces both neighboring ranges: ${releaseOrder}`, () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const allocator = new LinearMemoryAllocator(memory, 48, 1, 16, 7);
    const blocks = Array.from({ length: 5 }, () => allocator.allocate(4));
    for (const index of releaseOrder) allocator.release(blocks[index]);
    const joined = allocator.allocate(36);
    assert.equal(joined.offset, blocks[1].offset);
    assert.equal(joined.reservedByteLength, 48);
    for (const block of [...blocks, joined]) allocator.release(block);
    assert.deepEqual(allocationCounters(allocator), [0, 44, 0, 80]);
  });
}

test("CPU empty allocations preserve the first free address without consuming a range", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const allocator = new LinearMemoryAllocator(memory, 48, 1, 16, 7);
  const empty = allocator.allocate(0);
  const first = allocator.allocate(4), next = allocator.allocate(4);
  assert.equal(empty.offset, first.offset);
  allocator.release(first);
  const reusedEmpty = allocator.allocate(0);
  assert.equal(reusedEmpty.offset, first.offset);
  assert.deepEqual(allocationCounters(allocator), [4, 8, 16, 32]);
  allocator.release(empty);
  allocator.release(reusedEmpty);
  const reused = allocator.allocate(4);
  assert.equal(reused.offset, first.offset);
  for (const block of [empty, first, next, reusedEmpty, reused]) allocator.release(block);
  assert.deepEqual(allocationCounters(allocator), [0, 8, 0, 32]);
});

test("CPU release rejects a live foreign generation but ignores an already released one", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const allocator = new LinearMemoryAllocator(memory, 48, 1, 16, 7);
  const other = new LinearMemoryAllocator(memory, 128, 1, 16, 8);
  const owned = allocator.allocate(4), foreign = other.allocate(4);
  assert.throws(() => allocator.release(foreign), { code: "BACKEND_STATUS_ERROR" });
  assert.equal(foreign.released, false);
  assert.deepEqual(allocationCounters(allocator), [4, 4, 16, 16]);
  other.release(foreign);
  allocator.release(foreign);
  assert.deepEqual(allocationCounters(allocator), [4, 4, 16, 16]);
  allocator.release(owned);
  allocator.release(owned);
  assert.deepEqual(allocationCounters(allocator), [0, 4, 0, 16]);
});

test("CPU fragmented search survives largest-range splits, removal and new coalescing", () => {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1 });
  const allocator = new LinearMemoryAllocator(memory, 48, 1, 16, 7);
  const blocks = [64, 16, 16, 16, 32, 16].map(bytes => allocator.allocate(bytes));
  for (const index of [0, 2, 4]) allocator.release(blocks[index]);
  const first = allocator.allocate(32);
  const larger = allocator.allocate(48);
  const remainder = allocator.allocate(32);
  const last = allocator.allocate(32);
  assert.deepEqual([first.offset, larger.offset, remainder.offset, last.offset], [48, 208, 80, 160]);
  const miss = allocator.allocate(48);
  assert.equal(miss.offset, 256);
  const small = allocator.allocate(4);
  assert.equal(small.offset, 128);
  allocator.release(first);
  allocator.release(remainder);
  allocator.release(blocks[1]);
  const joined = allocator.allocate(80);
  assert.equal(joined.offset, 48);
  for (const block of [...blocks, first, larger, remainder, last, miss, small, joined]) allocator.release(block);
  assert.equal(allocator.livePayloadBytes, 0);
  assert.equal(allocator.liveReservedBytes, 0);
});

test("CPU rejected growth after fragmented reuse preserves the remaining range and counters", () => {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1 });
  const allocator = new LinearMemoryAllocator(memory, 48, 1, 16, 7);
  const hole = allocator.allocate(64), guard = allocator.allocate(16), tail = allocator.allocate(65_408);
  new Uint32Array(memory.buffer, guard.offset, 1)[0] = 123;
  allocator.release(hole);
  const first = allocator.allocate(32);
  const counters = allocationCounters(allocator);
  assert.throws(() => allocator.allocate(48), { code: "RESOURCE_EXHAUSTED" });
  assert.deepEqual(allocationCounters(allocator), counters);
  const second = allocator.allocate(32);
  assert.equal(second.offset, hole.offset + 32);
  allocator.release(first);
  allocator.release(second);
  const joined = allocator.allocate(64);
  assert.equal(joined.offset, hole.offset);
  assert.equal(new Uint32Array(memory.buffer, guard.offset, 1)[0], 123);
  assert.equal(memory.buffer.byteLength, 65_536);
  for (const block of [hole, guard, tail, first, second, joined]) allocator.release(block);
  assert.equal(allocator.livePayloadBytes, 0);
  assert.equal(allocator.liveReservedBytes, 0);
});

for (const rejection of ["configured limit", "host failure"]) {
  test(`CPU allocation recovers after memory growth rejection: ${rejection}`, () => {
    const maximumPages = rejection === "configured limit" ? 1 : 2;
    const memory = new WebAssembly.Memory({ initial: 1, maximum: maximumPages });
    const allocator = new LinearMemoryAllocator(memory, 48, maximumPages, 16, 7);
    const originalGrow = Object.getOwnPropertyDescriptor(memory, "grow");
    const hostError = new RangeError("Controlled memory growth rejection");
    const growthRequests = [];
    Object.defineProperty(memory, "grow", {
      configurable: true,
      value: (pages) => {
        growthRequests.push(pages);
        throw hostError;
      },
    });

    const allocations = [];
    try {
      const first = allocator.allocate(12);
      allocations.push(first);
      assert.deepEqual({ ...first }, {
        generation: 7, offset: 48, byteLength: 12, reservedByteLength: 16, released: false,
      });
      const firstState = { ...first };
      const buffer = memory.buffer;
      const firstData = new Float32Array(buffer, first.offset, 3);
      firstData.set([1.25, -2, 7]);
      assert.deepEqual(allocationCounters(allocator), [12, 12, 16, 16]);

      assert.throws(() => allocator.allocate(65_536), (error) => {
        assert.equal(error.code, "RESOURCE_EXHAUSTED");
        if (rejection === "configured limit") {
          assert.deepEqual(error.details, { maximumPages: 1, requiredPages: 2 });
          assert.equal(error.cause, undefined);
        } else {
          assert.deepEqual(error.details, { requiredPages: 2 });
          assert.equal(error.cause, hostError);
        }
        return true;
      });
      assert.deepEqual(growthRequests, rejection === "configured limit" ? [] : [1]);
      assert.equal(memory.buffer, buffer);
      assert.equal(memory.buffer.byteLength, 65_536);
      assert.deepEqual({ ...first }, firstState);
      assert.deepEqual([...firstData], [1.25, -2, 7]);
      assert.deepEqual(allocationCounters(allocator), [12, 12, 16, 16]);

      // No released range can conceal an incorrectly advanced allocation cursor.
      const next = allocator.allocate(20);
      allocations.push(next);
      assert.deepEqual({ ...next }, {
        generation: 7, offset: 64, byteLength: 20, reservedByteLength: 32, released: false,
      });
      new Float32Array(memory.buffer, next.offset, 5).set([3, 4, 5, 6, 7]);
      assert.deepEqual([...firstData], [1.25, -2, 7]);
      assert.deepEqual(allocationCounters(allocator), [32, 32, 48, 48]);
      assert.deepEqual(growthRequests, rejection === "configured limit" ? [] : [1]);

      allocator.release(first);
      allocator.release(next);
      assert.deepEqual(allocationCounters(allocator), [0, 32, 0, 48]);
    } finally {
      for (const allocation of allocations) allocator.release(allocation);
      if (originalGrow === undefined) delete memory.grow;
      else Object.defineProperty(memory, "grow", originalGrow);
    }
  });
}

function allocationCounters(allocator) {
  return [
    allocator.livePayloadBytes,
    allocator.highWaterPayloadBytes,
    allocator.liveReservedBytes,
    allocator.highWaterReservedBytes,
  ];
}
