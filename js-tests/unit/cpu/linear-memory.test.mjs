import assert from "node:assert/strict";
import { test } from "node:test";
import { LinearMemoryAllocator } from "../../../dist/backends/cpu/linear-memory.js";

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
